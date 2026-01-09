export function normalizeLiveKitUrl(url: string): string {
  if (url.startsWith("http://")) {
    return url.replace("http://", "ws://");
  }
  if (url.startsWith("https://")) {
    return url.replace("https://", "wss://");
  }
  return url;
}
