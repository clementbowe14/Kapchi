import { randomUUID } from "node:crypto";
import {
  browserApi,
  expect,
  test,
  waitForCorrelationEvidence,
} from "./staging/support";

test(
  "[OBS-CORRELATION-REDACTION] proves correlation and redaction from captured backend logs",
  { annotation: { type: "scenario-owner", description: "guest" } },
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "guest", "guest project owns the browser observability probe");
    await page.goto("/");
    const correlationId = `staging-${randomUUID()}`;
    const sensitiveProbe = `never-log-${randomUUID()}`;
    const response = await browserApi(page, "/health", {
      headers: {
        "x-request-id": correlationId,
        "x-staging-sensitive-probe": sensitiveProbe,
      },
    });
    expect(response.status).toBe(200);
    const evidence = await waitForCorrelationEvidence(correlationId, sensitiveProbe);
    expect(evidence).toEqual(expect.objectContaining({
      event: "http.request.completed",
      requestId: correlationId,
      statusCode: 200,
    }));
  },
);
