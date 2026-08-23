import { afterEach, describe, expect, it } from "vitest";
import { trustedHostnameHeaders } from "@/src/config/trusted-hostname";

const originalPublic = process.env.NEXT_PUBLIC_API_URL;
const originalEmergency = process.env.EMERGENCY_API_URL;

afterEach(() => {
  process.env.NEXT_PUBLIC_API_URL = originalPublic;
  process.env.EMERGENCY_API_URL = originalEmergency;
});

describe("trustedHostnameHeaders", () => {
  it("prefers NEXT_PUBLIC_API_URL over a Docker-internal emergency URL", () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:8080";
    process.env.EMERGENCY_API_URL = "http://backend:8080";
    expect(trustedHostnameHeaders()).toEqual({
      "x-mallanet-trusted-hostname": "localhost",
    });
  });

  it("skips the Docker DNS name backend", () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.EMERGENCY_API_URL = "http://backend:8080";
    expect(trustedHostnameHeaders()).toEqual({});
  });

  it("uses a public emergency URL when the public env is absent", () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.EMERGENCY_API_URL = "https://api-staging.terremotocolombia.co";
    expect(trustedHostnameHeaders()).toEqual({
      "x-mallanet-trusted-hostname": "api-staging.terremotocolombia.co",
    });
  });
});
