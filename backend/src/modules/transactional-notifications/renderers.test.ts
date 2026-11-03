import { describe, expect, it } from "vitest";
import { formatMinorUnits, renderNotification, safeItemSummaries } from "./renderers.js";

const base = {
  lookupUrl: "https://shop.kapchi.test/orders",
  publicOrderNumber: "KAP-1001"
};

describe("transactional notification rendering", () => {
  it("formats currencies from integer minor units", () => {
    expect(formatMinorUnits(1234, "usd")).toBe("$12.34");
    expect(formatMinorUnits(1234, "jpy")).toBe("¥1,234");
    expect(formatMinorUnits(1234, "kwd")).toContain("1.234");
  });

  it("renders each supported lifecycle kind", () => {
    expect(renderNotification("order.confirmed", "email", {
      ...base,
      currency: "usd",
      items: [{ quantity: 2, title: "Classic Stole" }],
      totalAmountMinor: 12900
    }).body).toContain("2 x Classic Stole");
    expect(renderNotification("order.cancelled", "email", base).body).toContain("cancelled");
    expect(renderNotification("refund.completed", "email", {
      ...base,
      currency: "usd",
      refundAmountMinor: 500
    }).body).toContain("$5.00");
    expect(renderNotification("order.shipped", "email", {
      ...base,
      carrier: "USPS",
      trackingNumber: "9400",
      trackingUrl: "https://tools.usps.com/track"
    }).body).toContain("Tracking number: 9400");
    expect(renderNotification("order.delivered", "sms", base).body).toContain("delivered");
  });

  it("extracts only title and quantity and strips control characters", () => {
    const summaries = safeItemSummaries([{
      customization: { text: "PRIVATE-CUSTOMIZATION" },
      imageUrl: "https://private.test/image",
      quantity: 1,
      title: "<b>Stole</b>\r\nBcc: private@example.test"
    }]);
    expect(summaries).toEqual([{
      quantity: 1,
      title: "Stole Bcc: private@example.test"
    }]);
    const rendered = renderNotification("order.confirmed", "email", {
      ...base,
      currency: "usd",
      items: summaries,
      totalAmountMinor: 1000
    }).body;
    expect(rendered).not.toContain("PRIVATE-CUSTOMIZATION");
    expect(rendered).not.toContain("imageUrl");
    expect(rendered).not.toContain("\r");
    expect(rendered).not.toContain("<b>");
  });

  it("bounds SMS output and summarizes omitted items", () => {
    const rendered = renderNotification("order.confirmed", "sms", {
      ...base,
      additionalItemCount: 7,
      currency: "usd",
      items: Array.from({ length: 10 }, (_, index) => ({
        quantity: 1,
        title: `${index}-${"x".repeat(120)}`
      })),
      totalAmountMinor: 1000
    });
    expect(rendered.body.length).toBeLessThanOrEqual(480);
    expect(rendered.subject.length).toBeLessThanOrEqual(160);
  });
});
