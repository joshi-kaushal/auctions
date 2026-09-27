import express, { Request, Response } from "express";
import mysql, { RowDataPacket } from "mysql2/promise";
import { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, PORT } from "./config";

const app = express();
app.use(express.json());

let pool: mysql.Pool | null = null;

// #region Create DB Pool
const createPool = async () => {
  const maxRetries = 10;
  const retryDelay = 2000; // 2 seconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      pool = mysql.createPool({
        host: DB_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });

      // Test the connection
      const connection = await pool.getConnection();
      connection.release();
      console.log("MySQL connected successfully");
      return;
    } catch (err) {
      console.warn(`MySQL connection attempt ${i + 1}/${maxRetries} failed, retrying in ${retryDelay}ms...`);
      if (i === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }
};
// #endregion Configuration

const initApp = async () => {
  await createPool();

  // #region GET /actions/:id
  app.get("/auctions/:id", async (req: Request, res: Response) => {
    const { id } = req.params;

    const [rows] = await pool!.execute<RowDataPacket[]>("SELECT * FROM auctions WHERE id = ?", [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "auction not found" });
    }

    const auction = rows[0] as {
      id: string;
      title: string;
      starting_bid: number;
      current_top_bid_id: string | null;
      current_top_amount: number | null;
      closes_at: Date;
      status: string;
    };

    return res.status(200).json({
      id: auction.id,
      title: auction.title,
      starting_bid: Number(auction.starting_bid),
      current_top_amount: auction.current_top_amount === null ? null : Number(auction.current_top_amount),
      current_top_bid_id: auction.current_top_bid_id,
      closes_at: new Date(auction.closes_at).toISOString(),
      status: auction.status,
    });
  });

  // #region GET /actions/
  app.get("/auctions", async (req: Request, res: Response) => {
    const [rows] = await pool!.execute<RowDataPacket[]>("SELECT * FROM auctions");
    const auctions = rows as {
      id: string;
      title: string;
      starting_bid: number;
      current_top_bid_id: string | null;
      current_top_amount: number | null;
      closes_at: Date;
      status: string;
    }[];

    return res.status(200).json(auctions.map(a => ({
      id: a.id,
      title: a.title,
      starting_bid: Number(a.starting_bid),
      current_top_amount: a.current_top_amount === null ? null : Number(a.current_top_amount),
      current_top_bid_id: a.current_top_bid_id,
      closes_at: new Date(a.closes_at).toISOString(),
      status: a.status,
    })));
  });

  // #region POST /bid
  app.post("/bid", async (req: Request, res: Response) => {
    const { auction_id, user_id, amount, idempotency_key } = req.body;

    if (!auction_id || !user_id || !amount || !idempotency_key) {
      return res.status(400).json({ error: "auction_id, user_id, amount, and idempotency_key are required" });
    }

    const connection = await pool!.getConnection();
    try {
      await connection.beginTransaction();

      // Lock the auction row
      const [auctions] = await connection.execute<RowDataPacket[]>(
        "SELECT * FROM auctions WHERE id = ? FOR UPDATE",
        [auction_id]
      );

      if (auctions.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "auction not found" });
      }

      const auction = auctions[0] as {
        id: string;
        title: string;
        starting_bid: number;
        current_top_bid_id: string | null;
        current_top_amount: number | null;
        closes_at: Date;
        status: string;
      };

      // Check if auction is closed
      const now = new Date();
      if (now >= auction.closes_at || auction.status === "closed") {
        await connection.rollback();
        return res.status(409).json({ error: "auction closed" });
      }

      // Compute effective floor
      const effectiveFloor = auction.current_top_amount ?? auction.starting_bid;

      if (amount <= effectiveFloor) {
        await connection.rollback();
        return res.status(409).json({ error: "bid too low" });
      }

      // Generate bid ID (UUID v4)
      const crypto = await import("crypto");
      const bid_id = crypto.randomUUID();

      // Insert the bid
      await connection.execute(
        "INSERT INTO bids (id, auction_id, user_id, amount, idempotency_key) VALUES (?, ?, ?, ?, ?)",
        [bid_id, auction_id, user_id, amount, idempotency_key]
      );

      // Update auction top bid fields
      await connection.execute(
        "UPDATE auctions SET current_top_bid_id = ?, current_top_amount = ? WHERE id = ?",
        [bid_id, amount, auction_id]
      );

      await connection.commit();

      return res.status(200).json({
        bid_id,
        auction_id,
        amount,
        status: "accepted",
      });
    } catch (err) {
      await connection.rollback();

      // Handle unique constraint violation (idempotency key duplicate)
      if (err && typeof err === "object" && "code" in err && (err as any).code === "ER_DUP_ENTRY") {
        // Look up the existing bid and return its result
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT * FROM bids WHERE auction_id = ? AND user_id = ? AND idempotency_key = ?",
          [auction_id, user_id, idempotency_key]
        );

        if (rows.length > 0) {
          const existingBid = rows[0] as {
            id: string;
            auction_id: string;
            user_id: string;
            amount: number;
            idempotency_key: string;
            created_at: Date;
          };
          return res.status(200).json({
            bid_id: existingBid.id,
            auction_id: existingBid.auction_id,
            amount: Number(existingBid.amount),
            status: "accepted",
          });
        }
      }

      console.error("Bid error:", err);
      return res.status(500).json({ error: "internal server error" });
    } finally {
      connection.release();
    }
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
};

initApp().catch((err) => {
  console.error("Failed to initialize app:", err);
  process.exit(1);
});

export { app };