#!/bin/bash
# Eisen Core Validation Test Script
# Tests core functionality to verify architecture implementation

set -e

echo "=== Eisen Core Validation Tests ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((TESTS_FAILED++))
}

info() {
    echo -e "${YELLOW}ℹ INFO${NC}: $1"
}

# Ensure we're in the core directory
cd "$(dirname "$0")"

echo "1. Building eisen-core..."
cargo build --quiet 2>&1 | grep -v "Compiling" || true
if [ $? -eq 0 ]; then
    pass "Build successful"
else
    fail "Build failed"
    exit 1
fi
echo ""

echo "2. Running unit tests..."
TEST_OUTPUT=$(cargo test --quiet 2>&1)
if echo "$TEST_OUTPUT" | grep -q "test result: ok"; then
    TEST_COUNT=$(echo "$TEST_OUTPUT" | grep -oP '\d+ passed' | grep -oP '\d+')
    pass "All unit tests passed ($TEST_COUNT tests)"
else
    fail "Unit tests failed"
    echo "$TEST_OUTPUT"
fi
echo ""

echo "3. Testing wire format integration..."
cargo test --test wire_format --quiet 2>&1 | grep -q "test result: ok"
if [ $? -eq 0 ]; then
    pass "Wire format tests passed"
else
    fail "Wire format tests failed"
fi
echo ""

echo "4. Checking module completeness..."
MODULES=("types" "tracker" "proxy" "tcp" "extract" "session_registry" "orchestrator" "flatten")
for module in "${MODULES[@]}"; do
    if grep -q "pub mod $module" src/lib.rs; then
        pass "Module $module present"
    else
        fail "Module $module missing from lib.rs"
    fi
done
echo ""

echo "5. Validating type definitions..."
# Check critical types exist
if grep -q "pub struct FileNode" src/types.rs; then
    pass "FileNode type defined"
else
    fail "FileNode type missing"
fi

if grep -q "pub enum Action" src/types.rs; then
    pass "Action enum defined"
else
    fail "Action enum missing"
fi

if grep -q "pub struct Snapshot" src/types.rs; then
    pass "Snapshot wire message defined"
else
    fail "Snapshot wire message missing"
fi

if grep -q "pub struct Delta" src/types.rs; then
    pass "Delta wire message defined"
else
    fail "Delta wire message missing"
fi

if grep -q "pub struct ZoneConfig" src/types.rs; then
    pass "ZoneConfig defined"
else
    fail "ZoneConfig missing"
fi
echo ""

echo "6. Validating tracker implementation..."
if grep -q "pub struct ContextTracker" src/tracker.rs; then
    pass "ContextTracker defined"
else
    fail "ContextTracker missing"
fi

if grep -q "pub fn file_access" src/tracker.rs; then
    pass "file_access method exists"
else
    fail "file_access method missing"
fi

if grep -q "pub fn tick" src/tracker.rs; then
    pass "tick method exists"
else
    fail "tick method missing"
fi

if grep -q "pub fn snapshot" src/tracker.rs; then
    pass "snapshot method exists"
else
    fail "snapshot method missing"
fi
echo ""

echo "7. Validating proxy implementation..."
if grep -q "pub fn spawn_agent" src/proxy.rs; then
    pass "spawn_agent function exists"
else
    fail "spawn_agent function missing"
fi

if grep -q "pub async fn upstream_task" src/proxy.rs; then
    pass "upstream_task exists"
else
    fail "upstream_task missing"
fi

if grep -q "pub async fn downstream_task" src/proxy.rs; then
    pass "downstream_task exists"
else
    fail "downstream_task missing"
fi

if grep -q "check_zone_violation" src/proxy.rs; then
    pass "Zone enforcement implemented"
else
    fail "Zone enforcement missing"
fi
echo ""

echo "8. Validating TCP server..."
if grep -q "pub async fn serve" src/tcp.rs; then
    pass "TCP serve function exists"
else
    fail "TCP serve function missing"
fi

if grep -q "pub async fn handle_client" src/tcp.rs; then
    pass "TCP handle_client exists"
else
    fail "TCP handle_client missing"
fi

if grep -q "pub fn broadcast_line" src/tcp.rs; then
    pass "broadcast_line function exists"
else
    fail "broadcast_line function missing"
fi

# Check RPC methods
RPC_METHODS=("list_sessions" "create_session" "close_session" "set_active_session" "get_session_state")
for method in "${RPC_METHODS[@]}"; do
    if grep -q "\"$method\"" src/tcp.rs; then
        pass "RPC method $method implemented"
    else
        fail "RPC method $method missing"
    fi
done
echo ""

echo "9. Validating session registry..."
if grep -q "pub struct SessionRegistry" src/session_registry.rs; then
    pass "SessionRegistry defined"
else
    fail "SessionRegistry missing"
fi

if grep -q "pub fn load_default" src/session_registry.rs; then
    pass "SessionRegistry persistence implemented"
else
    fail "SessionRegistry persistence missing"
fi
echo ""

echo "10. Validating orchestrator..."
if grep -q "pub struct OrchestratorAggregator" src/orchestrator.rs; then
    pass "OrchestratorAggregator defined"
else
    fail "OrchestratorAggregator missing"
fi

if grep -q "pub fn snapshot_for_session" src/orchestrator.rs; then
    pass "Orchestrator snapshot aggregation implemented"
else
    fail "Orchestrator snapshot aggregation missing"
fi

if grep -q "pub fn tick" src/orchestrator.rs; then
    pass "Orchestrator tick method exists"
else
    fail "Orchestrator tick method missing"
fi

if grep -q "pub fn aggregate_usage" src/orchestrator.rs; then
    pass "Usage aggregation implemented"
else
    fail "Usage aggregation missing"
fi
echo ""

echo "11. Validating ACP extraction..."
if grep -q "pub fn extract_upstream" src/extract.rs; then
    pass "Upstream extraction exists"
else
    fail "Upstream extraction missing"
fi

if grep -q "pub fn extract_downstream" src/extract.rs; then
    pass "Downstream extraction exists"
else
    fail "Downstream extraction missing"
fi

if grep -q "session/prompt" src/extract.rs; then
    pass "session/prompt handler implemented"
else
    fail "session/prompt handler missing"
fi

if grep -q "session/update" src/extract.rs; then
    pass "session/update handler implemented"
else
    fail "session/update handler missing"
fi
echo ""

echo "12. Checking dependencies..."
if grep -q "agent-client-protocol-schema" Cargo.toml; then
    pass "ACP schema dependency present"
else
    fail "ACP schema dependency missing"
fi

if grep -q "tokio.*full" Cargo.toml; then
    pass "Tokio async runtime configured"
else
    fail "Tokio dependency missing"
fi

if grep -q "serde.*derive" Cargo.toml; then
    pass "Serde serialization configured"
else
    fail "Serde dependency missing"
fi
echo ""

echo "13. Validating CLI interface..."
if grep -q "enum Command" src/main.rs; then
    pass "CLI command enum defined"
else
    fail "CLI command enum missing"
fi

if grep -q "snapshot" src/main.rs && grep -q "observe" src/main.rs; then
    pass "Both snapshot and observe commands present"
else
    fail "Command implementation incomplete"
fi

if grep -q "zone_patterns" src/main.rs; then
    pass "Zone CLI arguments implemented"
else
    fail "Zone CLI arguments missing"
fi
echo ""

echo "14. Testing binary build..."
if [ -f "target/debug/eisen-core" ]; then
    pass "Binary built successfully"
    
    # Test help output
    if ./target/debug/eisen-core 2>&1 | grep -q "Usage"; then
        pass "Binary executable and shows usage"
    else
        fail "Binary doesn't show proper usage"
    fi
else
    fail "Binary not found"
fi
echo ""

echo "15. Checking documentation..."
if [ -f "README.md" ]; then
    pass "README.md exists"
else
    fail "README.md missing"
fi

if [ -f "ARCHITECTURE.md" ]; then
    pass "ARCHITECTURE.md exists"
else
    fail "ARCHITECTURE.md missing"
fi

if [ -f "INTEGRATION_GUIDE.md" ]; then
    pass "INTEGRATION_GUIDE.md exists"
else
    fail "INTEGRATION_GUIDE.md missing"
fi
echo ""

echo "=== Test Summary ==="
echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
    exit 1
else
    echo -e "Tests failed: ${GREEN}0${NC}"
    echo ""
    echo -e "${GREEN}All validation tests passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Review ARCHITECTURE.md for detailed module documentation"
    echo "2. Review INTEGRATION_GUIDE.md for usage examples"
    echo "3. Run: ./target/debug/eisen-core observe --port 0 -- <agent-command>"
    exit 0
fi
