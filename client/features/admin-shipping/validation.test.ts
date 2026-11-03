import { describe, expect, it } from "vitest";
import { validatePackage } from "./validation";

describe("shipping package validation", () => {
  it("accepts bounded measurements with two decimals", () => {
    expect(validatePackage({
      description: "Graduation stole",
      heightInches: "2.25",
      lengthInches: "10",
      weightOunces: "12.5",
      widthInches: "8.00",
    })).toEqual({});
  });

  it("rejects zero, excessive precision, non-finite text, and upper-bound violations", () => {
    const errors = validatePackage({
      description: "x".repeat(121),
      heightInches: "0",
      lengthInches: "1.234",
      weightOunces: "Infinity",
      widthInches: "120.01",
    });
    expect(errors).toMatchObject({
      description: expect.any(String),
      heightInches: expect.any(String),
      lengthInches: expect.any(String),
      weightOunces: expect.any(String),
      widthInches: expect.any(String),
    });
  });
});
