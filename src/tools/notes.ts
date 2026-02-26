import { v4 as uuidv4 } from "uuid";
import { getDb } from "../memory/db";
import { registerTool } from "./registry";

const PROJECT_LABELS = ["Sofrecom", "YouCode", "Hack-Nation", "HR Platform", "Learning"];

registerTool({
  name: "save_note",
  description: "Save a fact, decision, idea, preference, or anything worth remembering long-term. The user can recall it later.",
  parameters: {
    content: { type: "string", description: "What to remember", required: true },
    project: { type: "string", description: "Related project", enum: PROJECT_LABELS },
    tags: { type: "string", description: "Comma-separated tags for easier recall (e.g. 'client,design,preference')" },
  },
  async execute(args, chatId) {
    const db = getDb();
    const id = uuidv4();
    db.prepare(
      "INSERT INTO notes (id, chat_id, content, project, tags) VALUES (?, ?, ?, ?, ?)"
    ).run(id, chatId, args.content, args.project || null, args.tags || null);
    return `Noted and saved (${id.slice(0, 8)}): "${args.content}"`;
  },
});

registerTool({
  name: "search_notes",
  description: "Search your long-term memory / saved notes by keyword, project, or tag",
  parameters: {
    query: { type: "string", description: "Search text (matches content, tags, or project)" },
    project: { type: "string", description: "Filter by project", enum: PROJECT_LABELS },
    limit: { type: "number", description: "Max results (default 10)" },
  },
  async execute(args, chatId) {
    const db = getDb();
    const limit = args.limit || 10;

    let sql = "SELECT id, content, project, tags, created_at FROM notes WHERE chat_id = ?";
    const params: any[] = [chatId];

    if (args.project) {
      sql += " AND project = ?";
      params.push(args.project);
    }

    if (args.query) {
      sql += " AND (content LIKE ? OR tags LIKE ?)";
      const q = `%${args.query}%`;
      params.push(q, q);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];

    if (rows.length === 0) return "No notes found matching that query.";

    const lines = rows.map((r) => {
      const proj = r.project ? ` [${r.project}]` : "";
      const tags = r.tags ? ` #${r.tags.replace(/,/g, " #")}` : "";
      const date = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `• ${r.content}${proj}${tags} (${date})`;
    });

    return `Notes (${rows.length}):\n${lines.join("\n")}`;
  },
});

registerTool({
  name: "delete_note",
  description: "Delete a saved note by its ID",
  parameters: {
    id: { type: "string", description: "Note ID or first 8 characters", required: true },
  },
  async execute(args, chatId) {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, content FROM notes WHERE chat_id = ? AND id LIKE ?"
    ).all(chatId, `${args.id}%`) as any[];

    if (rows.length === 0) return `Note "${args.id}" not found.`;

    db.prepare("DELETE FROM notes WHERE id = ?").run(rows[0].id);
    return `Deleted note: "${rows[0].content}"`;
  },
});
