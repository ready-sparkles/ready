import { seedDemo } from "./adapters/secondary/postgres/seed-demo";

const SEED_FAILED_MESSAGE = "Seed failed.";

void (async () => {
  try {
    await seedDemo();
  } catch (error) {
    console.error(SEED_FAILED_MESSAGE, error);
    process.exitCode = 1;
  }
})();
