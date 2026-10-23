import { parseASN1 } from "./signatures.js";

export function signatureImages(bytes) {
  // Render only the SES-defined picture field, never arbitrary ASN.1 octets.
  let root;
  try {
    root = parseASN1(bytes);
  } catch {
    return [];
  }
  const parts = root.valueBlock.value?.[0]?.valueBlock?.value;
  if (![1, 4].includes(parts?.[0]?.valueBlock?.valueDec)) return [];
  const info = parts?.[1]?.valueBlock?.value?.[0]?.valueBlock?.value;
  const image = info?.[3]?.valueBlock?.value?.[1]?.valueBlock?.valueHexView;
  return image?.length ? [image] : [];
}

