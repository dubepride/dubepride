/**
 * Metro resolves image imports to a numeric asset ID at build time. Declare
 * them here so `tsc --noEmit` understands `import logo from "./logo.png"`.
 */
declare module "*.png" {
  const asset: number;
  export default asset;
}
