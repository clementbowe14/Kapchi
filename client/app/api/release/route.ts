type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;

export type StorefrontReleaseIdentity = {
  environment: string;
  releaseDeploymentId: string;
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
    releaseDeploymentId:
      environment.RELEASE_DEPLOYMENT_ID ??
      environment.VERCEL_DEPLOYMENT_ID ??
      "development",
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
