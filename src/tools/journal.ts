import { v4 as uuidv4 } from "uuid";
import { getDb } from "../memory/db";
import { registerTool } from "./registry";

registerTool({
  name: "log_journal",
  description: "Log a daily journal entry — wins, blockers, mood, and a 1-5 rating. Builds accountability over time.",
  parameters: {
    wins: { type: "string", description: "What went well today" },
    blockers: { type: "string", description: "What blocked progress or was frustrating" },
    mood: { type: "string", description: "One-word mood (e.g. focused, tired, motivated, stressed)" },
    rating: { type: "number", description: "Day rating 1-5 (1=terrible, 5=amazing)" },
    notes: { type: "string", description: "Any extra thoughts or reflections" },
  },
  async execute(args, chatId) {
    const db = getDb();
    const id = uuidv4();
    db.prepare(
      "INSERT INTO journal (id, chat_id, wins, blockers, mood, rating, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, chatId, args.wins || null, args.blockers || null, args.mood || null, args.rating || null, args.notes || null);

    let resp = "Journal entry saved.";
    if (args.rating) {
      const label = ["", "Rough", "Meh", "Decent", "Good", "Crushing it"][args.rating] || "";
      resp += ` Rating: ${args.rating}/5 (${label})`;
    }
    return resp;
  },
});

registerTool({
  name: "get_journal",
  description: "Retrieve past journal entries for reflection, weekly planning, or pattern analysis",
  parameters: {
    period: { type: "string", description: "Time period", enum: ["today", "week", "month"] },
    limit: { type: "number", description: "Max entries (default 7)" },
  },
  async execute(args, chatId) {
    const db = getDb();
    const limit = args.limit || 7;
    const period = args.period || "week";

    let dateFilter: string;
    const now = new Date();
    if (period === "today") {
      dateFilter = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (period === "week") {
      dateFilter = new Date(now.getTime() - 7 * 86400000).toISOString();
    } else {
      dateFilter = new Date(now.getTime() - 30 * 86400000).toISOString();
    }

    const rows = db.prepare(
      "SELECT * FROM journal WHERE chat_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?"
    ).all(chatId, dateFilter, limit) as any[];

    if (rows.length === 0) return `No journal entries found for the past ${period}.`;

    const lines = rows.map((r) => {
      const date = new Date(r.created_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const parts: string[] = [`${date}`];
      if (r.rating) parts.push(`${r.rating}/5`);
      if (r.mood) parts.push(r.mood);
      if (r.wins) parts.push(`Wins: ${r.wins}`);
      if (r.blockers) parts.push(`Blockers: ${r.blockers}`);
      if (r.notes) parts.push(`Notes: ${r.notes}`);
      return `• ${parts.join(" | ")}`;
    });

    const avgRating = rows.filter((r) => r.rating).reduce((sum: number, r: any) => sum + r.rating, 0) / (rows.filter((r) => r.rating).length || 1);

    return `Journal (${rows.length} entries, avg rating: ${avgRating.toFixed(1)}/5):\n${lines.join("\n")}`;
  },
});
