//! Tests for Phase 3 zone enforcement: ZoneConfig matching, denied overrides,
//! and the glob matching implementation.

use eisen_core::types::ZoneConfig;

// -----------------------------------------------------------------------
// Basic zone matching
// -----------------------------------------------------------------------

#[test]
fn allowed_pattern_matches() {
    let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
    assert!(zone.is_allowed("src/ui/button.tsx"));
    assert!(zone.is_allowed("src/ui/components/header.tsx"));
    assert!(zone.is_allowed("src/ui/deep/nested/file.ts"));
}

#[test]
fn outside_zone_blocked() {
    let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
    assert!(!zone.is_allowed("core/src/auth.rs"));
    assert!(!zone.is_allowed("src/core/proxy.rs"));
    assert!(!zone.is_allowed("README.md"));
}

#[test]
fn leading_slash_normalized() {
    let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
    // Paths with leading slash should match the same patterns
    assert!(zone.is_allowed("/src/ui/button.tsx"));
    assert!(!zone.is_allowed("/core/auth.rs"));
}

#[test]
fn pattern_with_leading_slash() {
    let zone = ZoneConfig::new(vec!["/src/ui/**".to_string()]);
    assert!(zone.is_allowed("src/ui/button.tsx"));
    assert!(zone.is_allowed("/src/ui/button.tsx"));
}

// -----------------------------------------------------------------------
// Multiple allowed patterns
// -----------------------------------------------------------------------

#[test]
fn multiple_allowed_patterns() {
    let zone = ZoneConfig::new(vec!["src/ui/**".to_string(), "shared/**".to_string()]);
    assert!(zone.is_allowed("src/ui/button.tsx"));
    assert!(zone.is_allowed("shared/types.ts"));
    assert!(!zone.is_allowed("core/auth.rs"));
}

// -----------------------------------------------------------------------
// Denied patterns override allowed
// -----------------------------------------------------------------------

#[test]
fn denied_overrides_allowed() {
    let mut zone = ZoneConfig::new(vec!["src/**".to_string()]);
    zone.denied = vec!["**/.env".to_string()];

    assert!(zone.is_allowed("src/ui/button.tsx"));
    assert!(!zone.is_allowed("src/.env"));
    assert!(!zone.is_allowed("src/deep/.env"));
}

#[test]
fn denied_specific_file() {
    let mut zone = ZoneConfig::new(vec!["**".to_string()]); // allow everything
    zone.denied = vec!["secrets/**".to_string(), "**/.env".to_string()];

    assert!(zone.is_allowed("src/main.rs"));
    assert!(!zone.is_allowed("secrets/keys.json"));
    assert!(!zone.is_allowed("secrets/deep/private.pem"));
    assert!(!zone.is_allowed(".env"));
    assert!(!zone.is_allowed("config/.env"));
}

// -----------------------------------------------------------------------
// Exact file matching
// -----------------------------------------------------------------------

#[test]
fn exact_file_match() {
    let zone = ZoneConfig::new(vec!["package.json".to_string()]);
    assert!(zone.is_allowed("package.json"));
    assert!(!zone.is_allowed("src/package.json"));
    assert!(!zone.is_allowed("other.json"));
}

#[test]
fn exact_file_in_subdirectory_pattern() {
    let zone = ZoneConfig::new(vec!["config/tsconfig.json".to_string()]);
    assert!(zone.is_allowed("config/tsconfig.json"));
    assert!(!zone.is_allowed("tsconfig.json"));
}

// -----------------------------------------------------------------------
// Wildcard (*) patterns
// -----------------------------------------------------------------------

#[test]
fn star_pattern_in_filename() {
    let zone = ZoneConfig::new(vec!["*.config.js".to_string()]);
    assert!(zone.is_allowed("eslint.config.js"));
    assert!(zone.is_allowed("tailwind.config.js"));
    assert!(!zone.is_allowed("src/eslint.config.js")); // star only matches one segment
    assert!(!zone.is_allowed("config.ts"));
}

#[test]
fn star_pattern_in_directory() {
    let zone = ZoneConfig::new(vec!["src/*/index.ts".to_string()]);
    assert!(zone.is_allowed("src/ui/index.ts"));
    assert!(zone.is_allowed("src/core/index.ts"));
    assert!(!zone.is_allowed("src/ui/deep/index.ts")); // * doesn't match deep paths
}

// -----------------------------------------------------------------------
// Double-star (**) patterns
// -----------------------------------------------------------------------

#[test]
fn double_star_matches_any_depth() {
    let zone = ZoneConfig::new(vec!["**/test_*.py".to_string()]);
    assert!(zone.is_allowed("test_main.py"));
    assert!(zone.is_allowed("tests/test_main.py"));
    assert!(zone.is_allowed("a/b/c/test_deep.py"));
}

#[test]
fn double_star_at_end() {
    let zone = ZoneConfig::new(vec!["src/**".to_string()]);
    assert!(zone.is_allowed("src/file.rs"));
    assert!(zone.is_allowed("src/a/b/c.rs"));
    assert!(!zone.is_allowed("other/file.rs"));
}

#[test]
fn double_star_alone_matches_everything() {
    let zone = ZoneConfig::new(vec!["**".to_string()]);
    assert!(zone.is_allowed("anything.rs"));
    assert!(zone.is_allowed("deep/nested/path.ts"));
    assert!(zone.is_allowed("x"));
}

// -----------------------------------------------------------------------
// Empty zone (nothing allowed)
// -----------------------------------------------------------------------

#[test]
fn empty_allowed_blocks_everything() {
    let zone = ZoneConfig::new(vec![]);
    assert!(!zone.is_allowed("anything.rs"));
    assert!(!zone.is_allowed("src/main.rs"));
}

// -----------------------------------------------------------------------
// Shared zone patterns (typical config)
// -----------------------------------------------------------------------

#[test]
fn typical_shared_zone_config() {
    let zone = ZoneConfig::new(vec![
        "src/ui/**".to_string(),
        "package.json".to_string(),
        "tsconfig.json".to_string(),
        "*.config.js".to_string(),
        "*.config.ts".to_string(),
        "types/**".to_string(),
        "shared/**".to_string(),
    ]);

    // Agent's region files
    assert!(zone.is_allowed("src/ui/app.tsx"));
    assert!(zone.is_allowed("src/ui/components/button.tsx"));

    // Shared config files
    assert!(zone.is_allowed("package.json"));
    assert!(zone.is_allowed("tsconfig.json"));
    assert!(zone.is_allowed("eslint.config.js"));
    assert!(zone.is_allowed("vite.config.ts"));

    // Shared directories
    assert!(zone.is_allowed("types/auth.d.ts"));
    assert!(zone.is_allowed("shared/utils.ts"));

    // Not accessible
    assert!(!zone.is_allowed("core/src/auth.rs"));
    assert!(!zone.is_allowed("agent/src/main.py"));
}

// -----------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------

#[test]
fn empty_path_not_allowed() {
    let zone = ZoneConfig::new(vec!["src/**".to_string()]);
    assert!(!zone.is_allowed(""));
}

#[test]
fn path_with_dots() {
    let zone = ZoneConfig::new(vec!["src/**".to_string()]);
    assert!(zone.is_allowed("src/.eslintrc.json"));
    assert!(zone.is_allowed("src/..hidden/file.ts"));
}

#[test]
fn case_sensitive_matching() {
    let zone = ZoneConfig::new(vec!["src/UI/**".to_string()]);
    // Glob matching is case-sensitive
    assert!(zone.is_allowed("src/UI/button.tsx"));
    assert!(!zone.is_allowed("src/ui/button.tsx"));
}
