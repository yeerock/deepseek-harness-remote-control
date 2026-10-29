export const VERSION = '0.3.2';
export const USER_AGENT = `dsh-rc/${VERSION}`;

export function platformLabel(): string {
  return `${process.platform}-${process.arch}`;
}