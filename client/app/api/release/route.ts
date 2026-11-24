import { createHash } from "node:crypto";

type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;

export type StorefrontReleaseIdentity = {
  environment: string;
  environmentIdentity: string;
  releaseDeploymentId: string;
  registryVersion: string;
  releaseSha: string;
};

export function resolveStorefrontReleaseIdentity(
  environment: ReleaseEnvironment = process.env,
): StorefrontReleaseIdentity {
  return {
    environment:
      environment.KAPCHI_ENVIRONMENT ??
      environment.VERCEL_ENV ??
      environment.NODE_ENV ??
      "development",
    environmentIdentity: environment.RELEASE_ENVIRONMENT_IDENTITY_MARKER
      ? createHash("sha256")
          .update(`kapchi-deployment-identity:v1:${environment.RELEASE_ENVIRONMENT_IDENTITY_MARKER}`)
          .digest("hex")
      : "unconfigured",
    releaseDeploymentId:
      environment.RELEASE_DEPLOYMENT_ID ??
      environment.VERCEL_DEPLOYMENT_ID ??
      "development",
    registryVersion:
      environment.RELEASE_SCENARIO_REGISTRY_VERSION ?? "unconfigured",
    releaseSha:
      environment.RELEASE_SHA ??
      environment.VERCEL_GIT_COMMIT_SHA ??
      "development",
  };
}

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(resolveStorefrontReleaseIdentity(), {
    headers: {
      "cache-control": "no-store",
    },
  });
}
