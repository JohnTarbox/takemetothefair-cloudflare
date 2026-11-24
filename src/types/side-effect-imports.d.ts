// TypeScript 6 turns on `noUncheckedSideEffectImports` by default, so a bare
// `import "./globals.css"` must now resolve to a module TypeScript knows.
// Next bundles these stylesheets itself. These declarations only tell tsc
// they exist; they add no types to anything that is actually used.
declare module "*.css";
declare module "@jonnyboats/calendar-react/styles";
