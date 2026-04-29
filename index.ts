import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDesktopUseTool } from "./src/plugin-tool.js";

export default definePluginEntry({
  id: "opencoven-desktop-use",
  name: "OpenCoven Desktop Use",
  description:
    "Registers the desktop_use tool and delegates desktop automation to the external OpenCoven coven-desktop-use adapter.",
  register(api) {
    api.registerTool(createDesktopUseTool());
  },
});
