/** Vite bundles Markdown as local rule text. */
declare module '*?raw' {
  const content: string;
  export default content;
}
