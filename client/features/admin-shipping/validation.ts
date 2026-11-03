import type { PackageMeasurements } from "./types";

export type PackageField = keyof PackageMeasurements;
export type PackageErrors = Partial<Record<PackageField, string>>;

function decimal(value: string, label: string, minimum: number, maximum: number) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return `${label} must use a number with at most two decimal places.`;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    return `${label} must be between ${minimum} and ${maximum}.`;
  }
  return null;
}

export function validatePackage(input: PackageMeasurements): PackageErrors {
  const errors: PackageErrors = {};
  const values: Array<[Exclude<PackageField, "description">, string, number]> = [
    ["weightOunces", "Weight", 2400],
    ["lengthInches", "Length", 120],
    ["widthInches", "Width", 120],
    ["heightInches", "Height", 120],
  ];
  for (const [field, label, maximum] of values) {
    const error = decimal(input[field], label, 0.01, maximum);
    if (error) errors[field] = error;
  }
  if (input.description.trim().length > 120) errors.description = "Description must be 120 characters or fewer.";
  return errors;
}

export function packageIsValid(input: PackageMeasurements) {
  return Object.keys(validatePackage(input)).length === 0;
}
