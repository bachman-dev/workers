import bachmanDevConfig from "@bachman-dev/oxc-config/oxlint";

export default bachmanDevConfig(
  {},
  {
    ignorePatterns: ["workers/**/worker-configuration.d.ts", "workers/webhooks/src/types/github.ts"],
    options: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
