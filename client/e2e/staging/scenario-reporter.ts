import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import registry from "../../../deploy/staging-release-scenarios.json";
import { appendScenarioObservation } from "./support";

const SCENARIO_TAG = /\[([A-Z][A-Z0-9-]{2,63})\]/g;

type ScenarioResult = {
  assertionIds: string[];
  finishedAt: string;
  outcome: "failed" | "passed" | "skipped";
  scenarioId: string;
  startedAt: string;
  testId: string;
};

const scenarioContracts = new Map(registry.scenarios.map((scenario) => [scenario.id, {
  assertionIds: scenario.assertions.map((_, index) => `${scenario.id}:assertion:${index + 1}`),
  testIds: new Set(
    scenario.canonicalOwners
      .filter(({ file }) => file.includes(".staging.spec."))
      .flatMap(({ testIds }) => testIds),
  ),
}]));

export function reviewedScenarioIds(testTitle: string) {
  const explicitIds = [...testTitle.matchAll(SCENARIO_TAG)].map((match) => match[1]!);
  const ownedIds = [...scenarioContracts.entries()]
    .filter(([, contract]) => contract.testIds.has(testTitle))
    .map(([id]) => id);
  return [...new Set([...explicitIds, ...ownedIds])];
}

export class ScenarioResultCollector {
  private readonly results = new Map<string, ScenarioResult>();
  private readonly seen = new Set<string>();

  observe(input: {
    assertionIdsByScenario: Map<string, string[]>;
    finishedAt: string;
    ids: string[];
    ownerProject?: string;
    project: string;
    startedAt: string;
    status: TestResult["status"];
    testId: string;
  }) {
    for (const id of new Set(input.ids)) {
      const key = `${id}\0${input.testId}`;
      this.seen.add(key);
      const result = {
        assertionIds: input.assertionIdsByScenario.get(id) ?? [],
        finishedAt: input.finishedAt,
        scenarioId: id,
        startedAt: input.startedAt,
        testId: input.testId,
      };
      if (!input.ownerProject) {
        this.results.set(key, { ...result, outcome: "failed" });
        continue;
      }
      if (input.project !== input.ownerProject) {
        if (input.status !== "skipped") {
          this.results.set(key, { ...result, outcome: "failed" });
        }
        continue;
      }
      const outcome = input.status === "passed"
        ? "passed"
        : input.status === "skipped" ? "skipped" : "failed";
      const existing = this.results.get(key);
      this.results.set(key, existing?.outcome === "failed" ? existing : { ...result, outcome });
    }
  }

  finalize() {
    return [...this.seen].sort().map((key): ScenarioResult =>
      this.results.get(key) ?? {
        assertionIds: [],
        finishedAt: new Date(0).toISOString(),
        outcome: "failed",
        scenarioId: key.split("\0")[0]!,
        startedAt: new Date(0).toISOString(),
        testId: key.split("\0")[1]!,
      },
    );
  }
}

export default class ScenarioReporter implements Reporter {
  private readonly collector = new ScenarioResultCollector();

  async onTestEnd(test: TestCase, result: TestResult) {
    const ids = reviewedScenarioIds(test.title);
    if (ids.length === 0) return;
    const assertionIdsByScenario = new Map<string, string[]>();
    for (const id of ids) {
      const contract = scenarioContracts.get(id);
      if (!contract) throw new Error(`Staging test references unregistered scenario ${id}.`);
      if (!contract.testIds.has(test.title)) {
        throw new Error(`Staging test ${JSON.stringify(test.title)} is not a reviewed owner for ${id}.`);
      }
      assertionIdsByScenario.set(id, contract.assertionIds);
    }
    const ownerProject = test.annotations.find(({ type }) => type === "scenario-owner")?.description;
    const startedAt = result.startTime.toISOString();
    this.collector.observe({
      assertionIdsByScenario,
      finishedAt: new Date(result.startTime.getTime() + result.duration).toISOString(),
      ids,
      ownerProject,
      project: test.parent.project()?.name ?? "unknown",
      startedAt,
      status: result.status,
      testId: test.title,
    });
  }

  async onEnd() {
    const attemptId = process.env.E2E_STAGING_ATTEMPT_ID;
    const candidateSha = process.env.E2E_STAGING_CANDIDATE_SHA;
    if (!attemptId) throw new Error("E2E_STAGING_ATTEMPT_ID is required for scenario evidence.");
    if (!candidateSha || !/^[0-9a-f]{40}$/.test(candidateSha)) {
      throw new Error("E2E_STAGING_CANDIDATE_SHA must be a full lowercase Git SHA.");
    }
    for (const result of this.collector.finalize()) {
      await appendScenarioObservation({
        attemptId,
        candidateSha,
        observationVersion: 1,
        ...result,
      });
    }
  }
}
