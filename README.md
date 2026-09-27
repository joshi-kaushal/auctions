# NewArtX Auctions Service

A single-endpoint auction bidding service built with Node.js + TypeScript, Express, and MySQL 8.
Assignment ID: `v#hdf38%44`
See my thought process [here](#thought-process).

---

## Quick start

```bash
docker compose up --build
```

This starts both the MySQL container and the app container. The app listens on `http://localhost:3000`.

---

## Prerequisites

- Docker + Docker Compose
- Node.js 20+
- npm

---

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create `.env` file
   Copy the content from `.env.dist` file and paste it into the `.env`. You need to create `.env` first.

3. Start the containers:

```bash
docker compose up -d --build
```

4. Start the app locally against the Dockerized MySQL instance:

```bash
npm run dev
```

5. Verify with `curl` against the running server (OpenAPI spec can be found at `/openapi.yaml`. Also, manual verifiction scenarios provided below.)

---

## API surface

| Method | Path            | Request body                                       | Notes                                                       |
| ------ | --------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `POST` | `/bid`          | `{ auction_id, user_id, amount, idempotency_key }` | Creates or reuses a bid result for the same logical request |
| `GET`  | `/auctions/:id` | NA                                                 | For testing purposes only                                   |

### Supported request fields

- `auction_id`: auction identifier
- `user_id`: trusted client value for this assignment
- `amount`: bid amount
- `idempotency_key`: unique per retry; required to deduplicate duplicate requests

### Success and failure behavior

- `200` on accepted bid
- `200` on duplicate/retried request that matches the same `(auction_id, user_id, idempotency_key)` combination
- `400` when required fields are missing
- `404` when the auction does not exist
- `409` when the auction is closed or the bid is too low
- `500` for unexpected internal failures

---

## Design choices

### 1. Single source of truth for the top bid

The auction row stores:

- `current_top_bid_id`
- `current_top_amount`

Those values are updated only inside the same transaction that inserts the winning bid. This avoids ambiguity that would appear if the service tried to compute the top bid later with a separate `MAX()` query.

### 2. Concurrency control

The implementation uses `SELECT ... FOR UPDATE` inside a MySQL transaction before checking whether the bid is valid. This blocks concurrent writes on the same auction row until the transaction completes.

### 3. Idempotency

The `bids` table has a unique constraint on:

```sql
(auction_id, user_id, idempotency_key)
```

If a duplicate request arrives, the app catches the duplicate-key error and looks up the original bid row, returning its prior result instead of failing.

---

## Manual verification scenarios

After the server is running, test the four required scenarios using `curl`.

Use a real auction ID from the seeded data or from a read query against `/auctions/:id`.

```bash
# Happy path
curl -X POST http://localhost:3000/bid \
  -H 'Content-Type: application/json' \
  -d '{"auction_id":"<auction-id>","user_id":"user-1","amount":650,"idempotency_key":"bid-1"}'

# Bid too low
curl -X POST http://localhost:3000/bid \
  -H 'Content-Type: application/json' \
  -d '{"auction_id":"<auction-id>","user_id":"user-2","amount":500,"idempotency_key":"bid-2"}'

# Duplicate/retried bid
curl -X POST http://localhost:3000/bid \
  -H 'Content-Type: application/json' \
  -d '{"auction_id":"<auction-id>","user_id":"user-1","amount":650,"idempotency_key":"bid-1"}'

# Bid after close
curl -X POST http://localhost:3000/bid \
  -H 'Content-Type: application/json' \
  -d '{"auction_id":"<auction-id>","user_id":"user-3","amount":900,"idempotency_key":"bid-3"}'
```

Expected outcomes:

- successful bid: `200` with `{ bid_id, auction_id, amount, status: "accepted" }`
- low bid: `409` with `{ error: "bid too low" }`
- duplicate request: `200` with the original bid result
- closed auction: `409` with `{ error: "auction closed" }`

---

## Concurrency flow in one place

The bid placement logic is intentionally kept as a single transaction in a single async function:

```ts
await connection.beginTransaction();

const [rows] = await connection.execute(
  "SELECT * FROM auctions WHERE id = ? FOR UPDATE",
  [auction_id],
);

if (rows.length === 0) {
  await connection.rollback();
  return res.status(404).json({ error: "auction not found" });
}

const auction = rows[0];

if (new Date() >= auction.closes_at || auction.status === "closed") {
  await connection.rollback();
  return res.status(409).json({ error: "auction closed" });
}

const effectiveFloor = auction.current_top_amount ?? auction.starting_bid;

if (amount <= effectiveFloor) {
  await connection.rollback();
  return res.status(409).json({ error: "bid too low" });
}

await connection.execute(
  "INSERT INTO bids (id, auction_id, user_id, amount, idempotency_key) VALUES (?, ?, ?, ?, ?)",
  [bid_id, auction_id, user_id, amount, idempotency_key],
);

await connection.execute(
  "UPDATE auctions SET current_top_bid_id = ?, current_top_amount = ? WHERE id = ?",
  [bid_id, amount, auction_id],
);

await connection.commit();
```

This preserves correctness and makes the race-condition handling easy to review.

## Thought Process

### Data model

There are two tables: `bids` and `auctions`. The models can be found at `init.sql`.

1. The `bids` table stores records of each accepted bid, whereas `auctions` store data of all the auctions. There's no endpoint to add new autions so only two auctions from `init.sql` are considered.
2. The `current_top_bid_id` and `current_top_amount` columns in the `auctions` table help find the current top bid easy and cheap.
3. Top bid fields are are stored in the `auctions` table instead of deriving them with `max(amount)` because the bid insert and top-bid update happen together in one transaction while the auction row is locked. This gives us serialized decision point and returns current top bid unambigously.
4. I've also added a unique constraint on auction_id + user_id + idempotency_key so that same request dont add data in the db.

### Auction-close boundary

A bid is rejected when `now > closes_at`, OR when the auction status is already `closed`. The check happens after `SELECT ... FOR UPDATE`, so a request that has waited behind another bid evaluates the auction after it acquires the lock. The current route uses the Node process clock for `now`; for production, I would use the database clock consistently with `NOW(3)` to avoid disagreement between application and database clocks.

The auction status remains open even after `closed_at` time is passed. This is because we dont have any active mechanism that checks this at certain intervals (say each minute) and toggles the status.

### Placing a bid

Here's what happens when a new bid is placed via the `POST /bid` API:

1. Start the transaction and lock the target auction row.
2. Return not found if no auction exists, reject closed auctions or auctions with less/same price than starting bid / current top amount.
3. Insert the bid, update auction's top bid and amount and commit transaction.
4. If any other request for the same auction is triggered then it has to wait until it can acquire the lock. After acquiring the lock, step 1-3 are repeated.
5. A duplicate idempotency key returns the existing bid result rather than creating another bid.

### Bidding on your own top bid

If the new amount is higher than the current top bid, the bid is accepted regardless if the current top bidder is doing it again. The assignment description doesn't prohibit self outbidding. Hence the implementation permits it.

### Other concerns

1. No mechanism to switch status to close once `now > closes_at` becomes true.
2. The idempotency check currently happens after the auction-close and minimum-bid checks. This means a retry of an accepted bid can be rejected as “bid too low” because that bid is now the current top bid. A retry after the auction closes can also be rejected as `auction closed`. I would check for the existing auction_id +user_id + idempotency_key near the start of the transaction and return the stored result before applying the current auction rules. I would also verify that the retry has the same amount as the original request, and return a conflict if the same key is reused with a different amount.
3. Not mentioning auth, rate limiting, etc because they werent part of the scope.
