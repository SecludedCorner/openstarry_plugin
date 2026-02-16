declare module "mustache" {
  const Mustache: {
    render(template: string, view: unknown, partials?: unknown): string;
    escape: (value: string) => string;
  };
  export default Mustache;
}
