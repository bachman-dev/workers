import bachmanDev from "@bachman-dev/oxc-config/oxfmt";
import { defineConfig } from "oxfmt";

export default defineConfig(
  bachmanDev({}, { ignorePatterns: ["workers/**/worker-configuration.d.ts", "workers/**/drizzle/**"] }),
);
