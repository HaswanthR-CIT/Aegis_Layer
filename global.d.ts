// Plasmo-specific import schemes
declare module "data-text:*" {
  const content: string
  export default content
}

declare module "data-base64:*" {
  const content: string
  export default content
}

declare module "url:*" {
  const url: string
  export default url
}
