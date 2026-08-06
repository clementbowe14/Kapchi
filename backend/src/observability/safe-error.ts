type ErrorWithCode = Error & { code?: unknown };

const SAFE_ERROR_CODE = /^[A-Z0-9_.-]{1,64}$/i;

export type SafeErrorDetails = {
  errorCode?: string;
  errorType: string;
};

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  if (!(error instanceof Error)) {
    return { errorType: "UnknownError" };
  }

  const code = (error as ErrorWithCode).code;

  return {
    ...(typeof code === "string" && SAFE_ERROR_CODE.test(code)
      ? { errorCode: code }
      : {}),
    errorType: error.name || "Error"
  };
}
