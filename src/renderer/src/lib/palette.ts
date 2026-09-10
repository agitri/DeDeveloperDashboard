/**
 * The environment colours, in one place.
 *
 * This set is not a matter of taste: an earlier palette put Work and Personal
 * at ΔE 5.7 under deuteranopia — indistinguishable for a red-green colourblind
 * reader, on the one control whose whole job is telling two worlds apart. Every
 * adjacent pair here clears the threshold on both the light and dark surface.
 *
 * Anything that lets a user pick an environment or tab colour must offer these
 * and only these. A second copy is how a validated palette quietly stops being
 * one.
 */
export const ENV_COLORS: readonly string[] = [
  "#2f6ae8",
  "#c96a00",
  "#00a99f",
  "#c026a3",
  "#7c3aed",
  "#6b8f00",
];
