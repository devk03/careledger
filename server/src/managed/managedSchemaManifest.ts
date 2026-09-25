/** Independent hosted-E2EE lineage; never use for the community database. */
export const MANAGED_APPLICATION_ID = 0x41444e4f; // "ADNO"

export const MANAGED_MIGRATIONS = [
  [1, "identity_scopes", "96e1b5541389650818a961f81eda1696929721b99a454f364ac3ce17d623721b"],
  [2, "ciphertext_intake", "c727c2c1a4479a723753313fd2455e457c49e8c5361a71da63d8d2b6551ceae4"],
  [3, "day_revisions", "a51fdb6b99c0f49776e00effbfe97f39e4d9149317ee021139b076e913c71ac8"],
  [4, "staging_leases", "383ba1a2b5300c54978eceb5f22e0bbad9ce349d2ce006d70101aa65cfcc48b1"],
  [5, "non_day_intake", "4079814ea0db0ec83bc36674bce9085b4d2b47e9be576175abff0dcd0e259f44"],
  [6, "active_scope_keys", "a8e4fddaa37ac7f0b28d5ef56e20c8ddbdb7f06684de08dc3f6da226b92507d7"],
] as const;
