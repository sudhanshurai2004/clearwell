export const appMetrics = {
  increment: (name: string, value = 1) => {
    console.log(`[METRIC] ${name}=${value}`);
  },
  gauge: (name: string, value: number) => {
    console.log(`[GAUGE] ${name}=${value}`);
  },
  histogram: (name: string, value: number) => {
    console.log(`[HISTOGRAM] ${name}=${value}`);
  },
};
