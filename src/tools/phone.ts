import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config";
import { registerTool } from "./registry";

const supabase = createClient(config.supabase.url, config.supabase.anonKey);

type ParamDef = Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;

async function sendCommand(type: string, params?: Record<string, any>): Promise<string> {
  const commandId = uuidv4();
  const body: Record<string, any> = { type, command_id: commandId };
  if (params && Object.keys(params).length > 0) body.params = params;

  const { error } = await supabase.from("notifications").insert({
    body: JSON.stringify(body),
  });

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  return commandId;
}

interface CommandDef {
  name: string;
  description: string;
  command: string;
  parameters: ParamDef;
  /** Maps tool arg names to command param names when they differ */
  mapArgs?: (args: Record<string, any>) => Record<string, any>;
}

const commands: CommandDef[] = [
  // ─── Gestures ───
  {
    name: "phone_tap",
    description: "Tap at specific screen coordinates on the Android phone",
    command: "tap",
    parameters: {
      x: { type: "number", description: "X coordinate on screen", required: true },
      y: { type: "number", description: "Y coordinate on screen", required: true },
    },
  },
  {
    name: "phone_double_tap",
    description: "Double-tap at specific screen coordinates on the Android phone",
    command: "double_tap",
    parameters: {
      x: { type: "number", description: "X coordinate on screen", required: true },
      y: { type: "number", description: "Y coordinate on screen", required: true },
    },
  },
  {
    name: "phone_long_press",
    description: "Long-press at screen coordinates on the Android phone",
    command: "long_press",
    parameters: {
      x: { type: "number", description: "X coordinate on screen", required: true },
      y: { type: "number", description: "Y coordinate on screen", required: true },
      duration_ms: { type: "number", description: "Press duration in ms (default 1000)" },
    },
  },
  {
    name: "phone_swipe",
    description: "Perform a swipe gesture on the Android phone",
    command: "swipe",
    parameters: {
      direction: { type: "string", description: "Swipe direction", required: true, enum: ["up", "down", "left", "right"] },
      start_x: { type: "number", description: "Starting X coordinate (optional)" },
      start_y: { type: "number", description: "Starting Y coordinate (optional)" },
      distance: { type: "number", description: "Swipe distance in pixels (optional)" },
    },
  },

  // ─── Screenshot ───
  {
    name: "phone_screenshot",
    description: "Capture a screenshot of the Android phone screen (returns base64 PNG)",
    command: "screenshot",
    parameters: {},
  },

  // ─── App Management ───
  {
    name: "phone_list_apps",
    description: "List all installed apps on the Android phone (package name, app name, launcher activity)",
    command: "list_apps",
    parameters: {},
  },
  {
    name: "phone_launch_app",
    description: "Launch an app on the Android phone by package name",
    command: "launch_app",
    parameters: {
      package_name: { type: "string", description: "App package name (e.g. com.whatsapp)", required: true },
    },
  },
  {
    name: "phone_terminate_app",
    description: "Kill a background app process on the Android phone",
    command: "terminate_app",
    parameters: {
      package_name: { type: "string", description: "App package name to terminate", required: true },
    },
  },
  {
    name: "phone_install_app",
    description: "Install an APK from a file path on the Android phone",
    command: "install_app",
    parameters: {
      apk_path: { type: "string", description: "Path to the APK file on the device", required: true },
    },
  },
  {
    name: "phone_uninstall_app",
    description: "Open the uninstall prompt for an app on the Android phone",
    command: "uninstall_app",
    parameters: {
      package_name: { type: "string", description: "App package name to uninstall", required: true },
    },
  },
  {
    name: "phone_open_url",
    description: "Open a URL in the default browser on the Android phone",
    command: "open_url",
    parameters: {
      url: { type: "string", description: "URL to open", required: true },
    },
  },

  // ─── Screen Interaction ───
  {
    name: "phone_send_text",
    description: "Type text into the currently focused input field on the Android phone",
    command: "send_text",
    parameters: {
      text: { type: "string", description: "Text to type", required: true },
    },
  },
  {
    name: "phone_press_button",
    description: "Press a system button on the Android phone (home, back, recents, volume_up, volume_down, enter, dpad_up/down/left/right)",
    command: "press_button",
    parameters: {
      button: {
        type: "string",
        description: "Button to press",
        required: true,
        enum: ["home", "back", "recents", "volume_up", "volume_down", "enter", "dpad_up", "dpad_down", "dpad_left", "dpad_right"],
      },
    },
  },

  // ─── Screen Info ───
  {
    name: "phone_get_orientation",
    description: "Get the current screen orientation of the Android phone (portrait/landscape)",
    command: "get_orientation",
    parameters: {},
  },
  {
    name: "phone_set_orientation",
    description: "Lock the Android phone screen to a specific orientation",
    command: "set_orientation",
    parameters: {
      orientation: { type: "string", description: "Target orientation", required: true, enum: ["portrait", "landscape"] },
    },
  },
  {
    name: "phone_screen_size",
    description: "Get the Android phone screen dimensions (width, height in pixels) and orientation",
    command: "screen_size",
    parameters: {},
  },

  // ─── UI Analysis ───
  {
    name: "phone_get_ui_elements",
    description: "Get the full accessibility tree of the Android phone screen (class, text, bounds, clickable, etc.)",
    command: "get_ui_elements",
    parameters: {},
  },

  // ─── Device Utility ───
  {
    name: "phone_ring",
    description: "Ring the Android phone with sound and vibration, wake screen, show dismiss button",
    command: "ring",
    parameters: {},
  },
  {
    name: "phone_vibrate",
    description: "Vibrate the Android phone",
    command: "vibrate",
    parameters: {
      duration: { type: "number", description: "Duration in ms (100-10000, default 2000)" },
    },
  },
  {
    name: "phone_flash",
    description: "Turn on the Android phone camera flashlight",
    command: "flash",
    parameters: {
      duration: { type: "number", description: "Duration in ms (500-30000, default 3000)" },
    },
  },
  {
    name: "phone_device_info",
    description: "Get Android phone device info: model, API level, battery %, and connectivity status",
    command: "device_info",
    parameters: {},
  },
];

// ─── Register all phone commands ───

for (const cmd of commands) {
  registerTool({
    name: cmd.name,
    description: cmd.description,
    parameters: cmd.parameters,
    async execute(args) {
      const params = cmd.mapArgs ? cmd.mapArgs(args) : { ...args };
      const commandId = await sendCommand(cmd.command, Object.keys(params).length > 0 ? params : undefined);
      return `Phone command "${cmd.command}" sent (id: ${commandId})`;
    },
  });
}
