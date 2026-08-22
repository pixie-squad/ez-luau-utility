const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const BATTLE_PARAMETERS = [
  0, 0, 0, 0, 0, 0, 100, 0,
  0, 0, 0, 0, 13, 0, 4, 0,
  1, 1, 1, 2, 1, 0, 0, -1,
  100, 0, 0, 1, 1, 1, 1, 20
] as const;

export function createScriptingDeeplink(
  scriptUuid: string,
  shareToken: string,
  remoteBaseUrl: string
): string {
  if (scriptUuid.length === 0) {
    throw new Error("A script UUID is required to create a deeplink.");
  }
  if (shareToken.length === 0) {
    throw new Error("A share token is required to create a deeplink.");
  }

  const baseUrl = normalizeBaseUrl(remoteBaseUrl);
  const config = {
    realm: "experiment:scripts",
    script:
      `${baseUrl}/api/scripts/${encodeURIComponent(scriptUuid)}/content?token=` +
      encodeURIComponent(shareToken),
    bp: BATTLE_PARAMETERS
  };
  const payload = encodeBase62(
    new TextEncoder().encode(JSON.stringify(config))
  );

  return (
    "nullsbrawl://createAndJoinRoom" +
    `?roomname=params:v2:${payload}&friendly=1&side=0`
  );
}

export function encodeBase62(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }

  // Little-endian base-62 digits. Each pass multiplies the accumulated
  // number by 256 and adds the next byte, matching base-x conversion.
  const digits: number[] = [];
  for (let index = leadingZeroes; index < bytes.length; index += 1) {
    let carry = bytes[index] ?? 0;
    for (let digit = 0; digit < digits.length; digit += 1) {
      const value = (digits[digit] ?? 0) * 256 + carry;
      digits[digit] = value % BASE62_ALPHABET.length;
      carry = Math.floor(value / BASE62_ALPHABET.length);
    }
    while (carry > 0) {
      digits.push(carry % BASE62_ALPHABET.length);
      carry = Math.floor(carry / BASE62_ALPHABET.length);
    }
  }

  let encoded = BASE62_ALPHABET[0]?.repeat(leadingZeroes) ?? "";
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    encoded += BASE62_ALPHABET[digits[index] ?? 0] ?? "";
  }
  return encoded;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid remote base URL: ${JSON.stringify(value)}.`, {
      cause: error
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The remote base URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("The remote base URL cannot contain credentials.");
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}
