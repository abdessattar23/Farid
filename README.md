# Farid — WhatsApp AI Productivity Agent

Farid is an AI-powered WhatsApp assistant that helps you manage tasks, stay focused, and fight procrastination across multiple workstreams.

Built with **Evolution API** (WhatsApp), **Hack Club AI** (LLM), and **Linear** (task management).

## Architecture

```
WhatsApp ←→ Evolution API ←→ Farid Server ←→ Hack Club AI
                                  ↕
                               Linear API
                                  ↕
                            SQLite (memory)
```

**Flow**: Incoming WhatsApp messages hit the webhook → the agent loop sends them to the LLM with tool definitions → the LLM can call tools (Linear, reminders, focus mode) → results feed back to the LLM → final response goes back to WhatsApp.

## Features

### Task Management (Linear)
- Create, update, search, and complete tasks via natural language
- Tasks are organized by project labels: Sofrecom, YouCode, Hack-Nation, HR Platform, Learning
- Priority-based filtering and summaries

### Smart Reminders
- One-time reminders: "Remind me to submit the report at 6pm"
- Recurring reminders: "Remind me every weekday at 9am to check Hack-Nation"
- All reminders are persisted in SQLite and delivered via WhatsApp

### Focus Mode
- Start timed focus sessions: "Focus on Sofrecom for 2 hours"
- Get notified when focus time is up
- If you message during focus mode, Farid gently reminds you to stay on task

### Proactive Scheduling
- **Morning Brief** (8:00 AM, Mon-Fri): Task summary with today's priorities
- **Afternoon Nudge** (2:30 PM, Mon-Fri): Quick check-in
- **End-of-Day Review** (7:00 PM, Mon-Fri): Reflection prompt
- **Weekend Check-in** (9:00 AM, Sat-Sun): Lighter tone, focus on side projects
- **Weekly Planning** (8:00 PM, Sunday): Full week overview

### Productivity Stats
- Track focus time per project
- View activity history: today, this week, or this month

### Accountability Partner
- Farid calls out procrastination and redirects to pending tasks
- Motivating personality — direct, punchy, and action-oriented

## Prerequisites

1. **Node.js 18+** installed
2. **Evolution API** instance running and connected to WhatsApp
3. **Hack Club AI** API key — get one at [ai.hackclub.com/dashboard](https://ai.hackclub.com/dashboard)
4. **Linear** API key — create at [linear.app/settings/api](https://linear.app/settings/api)

## Setup

### 1. Clone and install

```bash
cd Farid
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Evolution API
EVOLUTION_API_URL=https://your-evolution-api.example.com
EVOLUTION_INSTANCE=farid
EVOLUTION_API_KEY=your_evolution_api_key

# Hack Club AI
HACKCLUB_API_KEY=your_hackclub_ai_key
HACKCLUB_MODEL=qwen/qwen3-32b

# Linear
LINEAR_API_KEY=lin_api_xxxxx

# Agent
OWNER_NUMBER=212xxxxxxxxx
PORT=3000
TIMEZONE=Africa/Casablanca
```

**OWNER_NUMBER**: Your WhatsApp number with country code, no `+` or spaces (e.g., `212612345678`).

### 3. Configure Evolution API webhook

Set your Evolution API instance to send webhooks to Farid. Call this endpoint on your Evolution API:

```bash
curl -X POST https://your-evolution-api.com/webhook/set/farid \
  -H "apikey: YOUR_EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server-url.com/webhook",
    "webhook_by_events": false,
    "webhook_base64": false,
    "events": [
      "MESSAGES_UPSERT"
    ]
  }'
```

Replace `https://your-server-url.com` with your Farid server's public URL.

> **For local development**: Use a tunnel like [ngrok](https://ngrok.com) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) to expose your local server:
> ```bash
> ngrok http 3000
> ```
> Then use the ngrok URL as your webhook URL.

### 4. Run

**Development** (with hot reload):
```bash
npm run dev
```

**Production**:
```bash
npm run build
npm start
```

## Project Structure

```
src/
  index.ts              — Express server, startup, graceful shutdown
  config.ts             — Typed environment variables
  webhook.ts            — Evolution API webhook handler (receives messages)
  whatsapp.ts           — Evolution API message sender
  agent.ts              — AI agent loop (LLM + tool execution)
  prompt.ts             — System prompt with personality and tool docs
  tools/
    registry.ts         — Tool registration and execution engine
    linear.ts           — Linear SDK tools (create, list, update, search, complete, summary)
    reminder.ts         — Reminder tools (set, recurring, list, cancel)
    productivity.ts     — Focus mode and stats tools
    index.ts            — Tool barrel export
  memory/
    db.ts               — SQLite setup and schema
    conversation.ts     — Conversation history persistence
    reminders.ts        — Reminder CRUD and scheduling logic
  scheduler/
    index.ts            — Cron jobs for reminders, briefs, and reviews
```

## How It Works

### Agent Loop

1. User sends a WhatsApp message
2. Evolution API forwards it to `/webhook` via HTTP POST
3. Farid loads conversation history from SQLite
4. Builds a prompt with system instructions + history + focus context
5. Sends to Hack Club AI (OpenAI-compatible chat completions)
6. If the LLM outputs a `:::tool_call:::` block, Farid executes the tool and feeds the result back
7. Loop continues until the LLM responds with plain text (max 5 tool rounds)
8. Final response is sent back via Evolution API

### Tool Calling

Farid uses **prompt-based tool calling** — the LLM outputs structured JSON in a specific format, which the server parses and executes. This works reliably across all models without requiring native function-calling support.

```
:::tool_call
{"name": "create_task", "args": {"title": "Fix auth bug", "project": "HR Platform", "priority": 1}}
:::
```

### Available Tools

| Tool | Description |
|------|-------------|
| `create_task` | Create a Linear issue with title, description, priority, project label |
| `list_my_tasks` | List open issues, optionally filtered by project or priority |
| `update_task` | Update task title, description, status, or priority |
| `search_tasks` | Search issues by text query |
| `complete_task` | Mark a task as done |
| `get_task_summary` | Summary of all tasks grouped by project |
| `set_reminder` | One-time reminder at a specific datetime |
| `set_recurring_reminder` | Recurring reminder (daily, weekdays, weekly, monthly) |
| `list_reminders` | Show all active reminders |
| `cancel_reminder` | Cancel a reminder by ID |
| `start_focus` | Start a timed focus session |
| `end_focus` | End focus session early |
| `get_stats` | Productivity stats (focus time, activity per project) |

## Example Conversations

**Creating a task:**
> You: I need to build the auth module for the HR platform, it's urgent
> Farid: Task created: [HR-42] "Build auth module for HR platform" — Priority: Urgent

**Checking tasks:**
> You: What should I work on?
> Farid: You have 3 urgent items. Top priority: [SOF-15] "Fix API endpoint" for Sofrecom. Start there.

**Setting a reminder:**
> You: Remind me at 6pm to submit the YouCode project
> Farid: Reminder set for Thu, Feb 26, 06:00 PM: "Submit the YouCode project"

**Focus mode:**
> You: I'm going to focus on Sofrecom for 2 hours
> Farid: Focus mode ACTIVATED for "Sofrecom" — 120 minutes until 5:30 PM. Now go crush it!

**Anti-procrastination:**
> You: I'm about to scroll Instagram
> Farid: Stop. You have 2 urgent tasks waiting. [SOF-15] needs you. Put the phone down and open your IDE. You got this.

## Deployment on Coolify

Farid includes a Dockerfile and is ready for Coolify deployment. Deploy it alongside your Evolution API on the same Coolify instance.

### Step-by-step

1. **Push to a Git repo** (GitHub, GitLab, etc.) — Coolify deploys from Git.

2. **In Coolify**, create a new resource:
   - Click **"Add New Resource"** → **"Application"**
   - Select your server and connect your Git repo
   - Coolify will detect the Dockerfile automatically

3. **Set environment variables** in the Coolify UI (Settings → Environment Variables):
   ```
   EVOLUTION_API_URL=https://your-evolution-api.example.com
   EVOLUTION_INSTANCE=farid
   EVOLUTION_API_KEY=your_key
   HACKCLUB_API_KEY=your_key
   HACKCLUB_MODEL=qwen/qwen3-32b
   LINEAR_API_KEY=lin_api_xxxxx
   OWNER_NUMBER=212xxxxxxxxx
   PORT=3000
   TIMEZONE=Africa/Casablanca
   ```

4. **Add a persistent volume** in Coolify (Settings → Storages):
   - Source path: `/data/coolify/farid` (or any path on host)
   - Destination path: `/data`
   - This keeps your SQLite database (conversations, reminders) safe across deploys

5. **Set the port** to `3000` in Coolify (Settings → Network)

6. **Deploy** — Coolify will build the Docker image and start the container

7. **Configure the webhook** — Once Farid has a public URL from Coolify (e.g., `https://farid.yourdomain.com`), set the Evolution API webhook:
   ```bash
   curl -X POST https://your-evolution-api.com/webhook/set/farid \
     -H "apikey: YOUR_EVOLUTION_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://farid.yourdomain.com/webhook",
       "webhook_by_events": false,
       "webhook_base64": false,
       "events": ["MESSAGES_UPSERT"]
     }'
   ```

8. **Verify** — Visit `https://farid.yourdomain.com/health` to confirm Farid is running, then send a WhatsApp message!

### Local Development

For local development with hot reload:
```bash
cp .env.example .env   # fill in your values
npm install
npm run dev
```

Use [ngrok](https://ngrok.com) to expose your local server for the webhook:
```bash
ngrok http 3000
```

## License

MIT
