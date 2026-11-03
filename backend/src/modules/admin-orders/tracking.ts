const aliases = new Map<string, { canonical: string; build: (value: string) => string; host: string }>([
  ["usps", { canonical: "USPS", host: "tools.usps.com", build: (value) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${value}` }],
  ["united states postal service", { canonical: "USPS", host: "tools.usps.com", build: (value) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${value}` }],
  ["ups", { canonical: "UPS", host: "www.ups.com", build: (value) => `https://www.ups.com/track?tracknum=${value}` }],
  ["united parcel service", { canonical: "UPS", host: "www.ups.com", build: (value) => `https://www.ups.com/track?tracknum=${value}` }],
  ["fedex", { canonical: "FedEx", host: "www.fedex.com", build: (value) => `https://www.fedex.com/fedextrack/?trknbr=${value}` }],
  ["fed ex", { canonical: "FedEx", host: "www.fedex.com", build: (value) => `https://www.fedex.com/fedextrack/?trknbr=${value}` }],
  ["federal express", { canonical: "FedEx", host: "www.fedex.com", build: (value) => `https://www.fedex.com/fedextrack/?trknbr=${value}` }],
  ["dhl", { canonical: "DHL", host: "www.dhl.com", build: (value) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${value}` }],
  ["dhl express", { canonical: "DHL", host: "www.dhl.com", build: (value) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${value}` }]
]);

export function normalizeCarrier(value: string) {
  const trimmed = value.trim().replace(/[\t\n\r ]+/g, " ");
  return aliases.get(trimmed.toLowerCase())?.canonical ?? trimmed;
}

export function trackingIdentity(value: string) {
  return value.trim().replace(/[ -]/g, "").toUpperCase();
}

export function deriveTrackingUrl(carrier: string, trackingNumber: string) {
  const alias = aliases.get(carrier.trim().replace(/[\t\n\r ]+/g, " ").toLowerCase());
  if (!alias || trackingIdentity(trackingNumber).length === 0) return null;
  try {
    const url = new URL(alias.build(encodeURIComponent(trackingNumber.trim())));
    if (
      url.protocol !== "https:" ||
      url.hostname !== alias.host ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function confirmedTrackingIdentity(carrier: string, trackingNumber: string) {
  return `${normalizeCarrier(carrier).toUpperCase()}:${trackingIdentity(trackingNumber)}`;
}
