const productionPublication =
  process.env.VERCEL_ENV === "production" ||
  process.env.KAPCHI_PRODUCTION_PUBLICATION === "1";

if (!productionPublication) {
  console.log("Policy publication guard skipped for this local or preview build.");
} else {
  await import("./validate-policy-publication.mjs");
}
