/**
 * Typed façade for /sol's automatic pi-oracle High/Power-slider restore.
 * Implementation lives in apply-sol-patches.mjs so `node` can run it too.
 */
export {
	SOL_PATCH_MARKERS,
	defaultOracleRoot,
	defaultVendorDir,
	ensureSolOraclePatches,
	formatSolPatchNote,
} from "./apply-sol-patches.mjs";

export type SolPatchResult = {
	ok: boolean;
	restored: boolean;
	missing: string[];
	error?: string;
	root: string;
};
