// Ambient declaration for the CSS files a bundle imports for their side effects (React Flow's own
// stylesheet and diagram.css, in webviews/diagram/app.tsx). esbuild handles these for real - it extracts
// every imported stylesheet into dist/webviews/{bundle}/index.css, which the webview's HTML shell loads
// alongside index.js - but TypeScript has no built-in notion of a ".css module", so without this there is
// nothing for it to resolve the import path to.
//
// `tsc -p webviews` happens to stay quiet even without this file, which is why it went unnoticed: for a
// side-effect-only import (`import 'x';`, no binding) TypeScript never reports an unresolved module,
// because it only needs the module's type once something is actually bound from it. Add a binding - or
// open the file in an editor running a different TypeScript version or a fallback/inferred project - and
// the error appears immediately. Declaring the module makes these imports legitimately typed rather than
// incidentally tolerated.
declare module '*.css';
