/** Independent hosted-E2EE lineage; never use for the community database. */
export const MANAGED_APPLICATION_ID = 0x41444e4f; // "ADNO"

export const MANAGED_MIGRATIONS = [
  [1, "identity_scopes", "96e1b5541389650818a961f81eda1696929721b99a454f364ac3ce17d623721b"],
  [2, "ciphertext_intake", "c727c2c1a4479a723753313fd2455e457c49e8c5361a71da63d8d2b6551ceae4"],
  [3, "day_revisions", "a51fdb6b99c0f49776e00effbfe97f39e4d9149317ee021139b076e913c71ac8"],
] as const;
