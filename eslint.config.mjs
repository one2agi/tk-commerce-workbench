// 极简 flat config。
// Web 包内部使用 eslint-config-next 提供的 next lint 命令；本配置只为其它非 Web 工作空间提供兜底。
export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      ".worktrees/**",
      ".superpowers/**",
      "**/coverage/**",
      "**/data/**"
    ]
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "no-unused-vars": "off"
    }
  }
];
