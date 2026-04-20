import { runNativeHost } from "../src/native-host/main.js";

runNativeHost().catch((error) => {
  console.error(error);
  process.exit(1);
});
