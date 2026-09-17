import { readFile } from "node:fs/promises";
import { FileSteeringStore } from "../../src/storage/file/steering-store";
import { applySteeringMaterialization } from "../../src/steering-materialization";
import type { SteeringMaterializationFailpoint } from "../../src/steering-materialization";

const [root, planPath, boundary] = process.argv.slice(2);
if (!root || !planPath || !boundary) throw new Error("root, plan, and failpoint are required");
const store = new FileSteeringStore(root);
const plan = JSON.parse(await readFile(planPath, "utf8"));
await applySteeringMaterialization({
  project_root: root,
  store,
  blobs: store.blobs,
  plan,
  file_options: {
    failpoint: (point: SteeringMaterializationFailpoint) => {
      if (point === boundary) process.kill(process.pid, "SIGKILL");
    },
  },
});
