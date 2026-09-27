# NewArt_X Auctions Service

A single-endpoint auction bidding service built with Node.js + TypeScript, Express, and MySQL 8.
Assignment ID: `v#hdf38%44`

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Local Development](#local-development)
4. [API Endpoints](#api-endpoints)
5. [Design Mechanisms](#design-mechanisms)
6. [Manual Verification](#manual-verification)
7. [Testing Scenarios](#testing-scenarios)

---

## Quick Start

```bash
docker-compose up --build     # starts mysql + app, runs init.sql on first boot
npm run dev                   # local dev against dockerized mysql
```

---

## Prerequisites

- [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)
- [Node.js](https://nodejs.org/) (>=20) and [pnpm](https://pnpm.io/) or npm
- `mysql8` service defined in `docker-compose.yml`

---

## Local Development

1. **Start infrastructure**

   ```bash
   docker-compose up -d
   ```

   This brings up:
   - `mysql` service (MySQL 8)
   - `app` service (Node/TS server)

2. **Install dependencies**

   ```bash
   pnpm install       # or npm install
   ```

3. **Run migrations / init DB** (happens automatically on first `docker-compose up` via `init.sql`)

4. **Start the server**

   ```bash
   npm run dev        # watches ts files, restarts on change, connects to docker mysql
   ```

   The server listens on `http://localhost:3000`.

5. **Verify** (example curl)

   ```bash
   curl -X POST localhost:3000/bid -d '{"auction_id":1,"user_id":1,"amount":100}' -H 'Content-Type: application/json'
   ```

---

## API Endpoints

| Method | Path            | Request Body                      | Description                                     |
| ------ | --------------- | --------------------------------- | ----------------------------------------------- |
| `POST` | `/bid`          | `{ auction_id, user_id, amount }` | Place a bid (idempotent)                        |
| `GET`  | `/auctions/:id` | —                                 | Read‑only auction details (manual verification) |

---

## Design Mechanisms

### 1. Top‑bid correctness (single source of truth)

- `auctions.current_top_amount` and `current_top_bid_id` are updated **only** inside the same transaction that inserts the winning bid.
- No separate `MAX()` queries elsewhere – eliminates race‑condition ambiguity.

### 2. Concurrency control (`SELECT ... FOR UPDATE`)

- Inside a MySQL transaction, the auction row is locked with `SELECT ... FOR UPDATE` before checking/updating the top bid.
- This is the **explicit** chosen mechanism (see `plan.md` for the reasoning). Do not swap for Redis, optimistic version columns, or application‑level locking.

### 3. Idempotency

- Unique constraint on `(auction_id, user_id, idempotency_key)` in the `bids` table.
- A conflicting insert returns the existing bid’s result instead of erroring.

### 4. No Redis / no message queue

- Explicitly rejected for this scope. All state lives in MySQL within the transaction.

### 5. Auth absent

- `user_id` is trusted from the request body. No auth middleware.

---

## Manual Verification (four scenarios)

Run these with `curl` after the server is up:

| Scenario                               | Curl Command                                                                                                         | Expected Outcome                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Happy path** – valid new bid         | `curl -X POST localhost:3000/bid -d '{"auction_id":1,"user_id":1,"amount":150}' -H 'Content-Type: application/json'` | `201 Created`, bid stored, `current_top_amount` updated to 150.                                                                      |
| **Bid too low**                        | `curl -X POST localhost:3000/bid -d '{"auction_id":1,"user_id":1,"amount":50}' -H 'Content-Type: application/json'`  | `400 Bad Request` (or appropriate error), bid rejected because `amount <= current_top_amount`.                                       |
| **Duplicate/retried bid** (idempotent) | `curl -X POST localhost:3000/bid -d '{"auction_id":1,"user_id":1,"amount":200}' -H 'Content-Type: application/json'` | Returns the **existing** bid result (201 or 400 depending on prior state). No duplicate row; idempotency key prevents re‑processing. |
| **Bid after close**                    | First close the auction (e.g., update `auctions.closed_at`), then attempt a bid.                                     | `403 Forbidden` (or appropriate error), bid rejected because auction is closed.                                                      |

---

## Testing Scenarios (manual, per assignment)

- **Happy path** – successful bid, top‑bid updates correctly.
- **Bid too low** – server rejects amount ≤ current top.
- **Duplicate/retried bid** – same idempotency key returns existing result; no error, no duplicate.
- **Bid after close** – auction closed → bid rejected.

> **Do not add a test framework (Jest, etc.)** – the assignment expects only manual curl verification within the 90‑minute budget.

---

## Project Structure (high‑level)

```
├─ docker-compose.yml          # mysql + app services
├─ init.sql                   # DB schema + seed data (run once)
├─ src/
│  ├─ server.ts               # Express entry point
│  ├─ routes/
│  │   └─ bid.ts              # POST /bid handler
│  └─ db/
│     └─ queries.sql          # raw SQL (SELECT ... FOR UPDATE, INSERT, etc.)
├─ .env                       # DB connection, port, etc.
├─ tsconfig.json
└─ README.md                  # this file
```

---

## How Concurrency Works (single function)

```ts
// src/routes/bid.ts  (simplified)
async function placeBid(req, res) {
  const { auction_id, user_id, amount, idempotency_key } = req.body;

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    // 1. Lock the auction row
    const [auctions] = await connection.execute<
      Array<{ current_top_amount: number }>
    >("SELECT current_top_amount FROM auctions WHERE id = ? FOR UPDATE", [
      auction_id,
    ]);

    const top = auctions[0]?.current_top_amount ?? 0;

    // 2. Validate amount > top
    if (amount <= top) {
      await connection.rollback();
      return res.status(400).json({ error: "Bid too low" });
    }

    // 3. Insert bid (idempotency via unique constraint)
    await connection.execute(
      "INSERT INTO bids (auction_id, user_id, amount, idempotency_key) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)",
      [auction_id, user_id, amount, idempotency_key],
    );

    // 4. Update top‑bid fields inside same transaction
    await connection.execute(
      "UPDATE auctions SET current_top_amount = ?, current_top_bid_id = ? WHERE id = ?",
      [amount, result.insertId, auction_id],
    );

    await connection.commit();
    res.status(201).json({ top_amount: amount, bid_id: result.insertId });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: "Internal error" });
  } finally {
    connection.release();
  }
}
```

- The function is **linear** – a single transaction from lock → validate → insert → update → commit.
- No helper spread‑across‑files; a reviewer can read the whole race‑condition handling in one place.

---

## How Idempotency Works

- The `bids` table has a **unique index** on `(auction_id, user_id, idempotency_key)`.
- The INSERT statement uses `ON DUPLICATE KEY UPDATE amount = VALUES(amount)`.
- If a duplicate key occurs, MySQL updates the existing row and returns the **existing** bid result (the function sees `result.affectedRows === 0` and can return the prior bid’s data).
- Application never throws on conflict – it simply returns the prior outcome.

---

## How Close‑Boundary Handling Works

- The `auctions` table has a `closed_at` column (`DATETIME`).
- Before any bid validation, the handler checks `if (auction.closed_at && new Date() >= auction.closed_at)` and returns `403 Forbidden`.
- This check occurs **inside** the same `SELECT ... FOR UPDATE` transaction, so the close boundary cannot be raced past.

---

## Environment Variables (`.env`)

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=newartx_auctions
PORT=3000
```

---

## Known Limitations / Underspecified Items (Yet to answer)

- **Self‑bid decision** – whether a user may bid on their own auction is left unspecified; the current implementation simply trusts the `user_id` from the request.
- **Underspecified boundary conditions** – e.g., what happens when two bids with the _exact same amount_ arrive concurrently. The current logic (`amount <= top`) treats equal amounts as "too low"; you may adjust per your own rule.
- **Data‑model rationale** – you'll document why `current_top_amount`/`current_top_bid_id` are the single source of truth rather than a separate `MAX()` query.
- **Close‑boundary handling** – you may decide whether a bid placed at the exact close moment should be accepted or rejected.
- **Duplicate‑bid handling edge cases** – e.g., what if the idempotency key is omitted? (Currently the column allows `NULL` and the unique constraint does not cover it; you may add a default generated key.)

---
