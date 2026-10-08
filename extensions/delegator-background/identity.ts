/** Collision-checked UUID prefixes for the current retained/visible job cohort. */
export function shortJobId(taskId: string, taskIds: readonly string[], minimum = 4): string {
	const compact = (id: string) => id.replace(/^del-/u, "").replace(/-/gu, "");
	const own = compact(taskId);
	const others = taskIds.filter((id) => id !== taskId).map(compact);
	let length = Math.min(minimum, own.length);
	while (length < own.length && others.some((other) => other.startsWith(own.slice(0, length)))) length += 1;
	return own.slice(0, length);
}
