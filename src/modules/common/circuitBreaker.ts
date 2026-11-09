import CircuitBreaker from "opossum";

export function createPspStatusBreaker<T extends (...args: any[]) => Promise<any>>(fn: T) {
  return new CircuitBreaker(fn, {
    timeout: 1500,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    volumeThreshold: 5,
  });
}
