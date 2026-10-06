declare module "qrcode-terminal" {
  const qr: { generate(text: string, opts: { small?: boolean }, cb: (code: string) => void): void };
  export default qr;
}
