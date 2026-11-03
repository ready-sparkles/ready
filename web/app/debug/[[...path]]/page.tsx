import { notFound } from "next/navigation";

// Reserve this path so removed tooling cannot resolve as a meeting room.
export default function RemovedDebugPage() {
  notFound();
}
