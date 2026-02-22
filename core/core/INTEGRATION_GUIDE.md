# Eisen Core Integration Guide

## Quick Start

### Starting eisen-core

```bash
# Proxy mode with auto-assigned port
./eisen-core observe --port 0 --agent-id opencode-a1b2c3 -- opencode acp

# With zone enforcement (region isolation)
./eisen-core observe --port 0 \
  --agent-id ui-agent-xyz \
  --zone "src/ui/**" \
  --zone "shared/**" \
  --deny "**/.env" \
  -- opencode acp

# Parse stderr for TCP port
# Output: "eisen-core tcp port: 54321"
```

### Connecting as a TCP Client

```python
import socket
import json

# Connect to the port from stderr
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect(("127.0.0.1", 54321))
file = sock.makefile('r')

# Receive initial snapshot
snapshot = json.loads(file.readline())
print(f"Tracking {len(snapshot['nodes'])} files")

# Stream deltas
for line in file:
    msg = json.loads(line)
    if msg['type'] == 'delta':
        print(f"Updates: {len(msg['updates'])}, Removed: {len(msg['removed'])}")
    elif msg['type'] == 'usage':
        print(f"Token usage: {msg['used']}/{msg['size']}")
    elif msg['type'] == 'blocked':
        print(f"BLOCKED: {msg['path']} ({msg['action']})")
```

---

## Data Management Strategies

### 1. File Activity Tracking

**Heat-Based Decay Model**

Each file has a "heat" value (0.0 to 1.0) representing recent activity:

```
Access event → heat = 1.0
Every 100ms → heat *= 0.95 (for non-context files)
heat < 0.01 → prune from tracking
```

**Context Window Awareness**

Files are marked `in_context` based on:
- Recent access (within last N turns, default 3)
- Explicit user mentions (@file.rs in prompt)
- Active agent operations (reads, writes)

**Use Case: Visualize "Hot" Files**

```python
def get_hot_files(snapshot, threshold=0.5):
    """Return files with high activity"""
    return [
        (path, node['heat'])
        for path, node in snapshot['nodes'].items()
        if node['heat'] >= threshold
    ]

def get_context_files(snapshot):
    """Return files currently in agent's context"""
    return [
        path for path, node in snapshot['nodes'].items()
        if node['in_context']
    ]
```

### 2. Session Management

**Single-Agent Sessions**

Basic mode for standalone agent instances:

```python
import requests

def create_single_agent_session(tcp_sock, agent_id, session_id):
    """Create a basic session"""
    rpc = {
        "type": "rpc",
        "id": "req_001",
        "method": "create_session",
        "params": {
            "agent_id": agent_id,
            "session_id": session_id,
            "mode": "single_agent",
            "model": {
                "model_id": "claude-sonnet-4",
                "name": "Claude Sonnet 4"
            },
            "summary": None,
            "history": [],
            "context": [],
            "providers": []
        }
    }
    tcp_sock.sendall((json.dumps(rpc) + "\n").encode())
    response = json.loads(tcp_sock.makefile('r').readline())
    return response['result']
```

**Orchestrator Sessions**

Coordinate multiple agents with unified view:

```python
def create_orchestrator_session(tcp_sock, agent_id, session_id, provider_keys):
    """
    Create orchestrator that aggregates provider sessions.
    
    Args:
        provider_keys: List of {"agent_id": "...", "session_id": "..."}
    """
    rpc = {
        "type": "rpc",
        "id": "req_002",
        "method": "create_session",
        "params": {
            "agent_id": agent_id,
            "session_id": session_id,
            "mode": "orchestrator",
            "model": None,
            "summary": "Multi-agent coordination session",
            "history": [],
            "context": [],
            "providers": provider_keys
        }
    }
    tcp_sock.sendall((json.dumps(rpc) + "\n").encode())
    response = json.loads(tcp_sock.makefile('r').readline())
    return response['result']

# Example: Coordinate UI and Core agents
provider_keys = [
    {"agent_id": "ui-agent-abc", "session_id": "sess_ui_001"},
    {"agent_id": "core-agent-xyz", "session_id": "sess_core_001"}
]
orch = create_orchestrator_session(sock, "orchestrator-123", "sess_orch_001", provider_keys)
```

**Switching Active Session**

```python
def set_active_session(tcp_sock, agent_id, session_id):
    """Set default session for tracker operations"""
    rpc = {
        "type": "rpc",
        "id": "req_003",
        "method": "set_active_session",
        "params": {
            "agent_id": agent_id,
            "session_id": session_id
        }
    }
    tcp_sock.sendall((json.dumps(rpc) + "\n").encode())
    response = json.loads(tcp_sock.makefile('r').readline())
    return response['result']['active']
```

### 3. Stream Filtering

**Filter by Session**

Only receive updates for specific session:

```python
def filter_by_session(tcp_sock, session_id):
    """Receive only messages for one session"""
    filter_msg = {
        "type": "set_stream_filter",
        "session_id": session_id,
        "session_mode": None
    }
    tcp_sock.sendall((json.dumps(filter_msg) + "\n").encode())
```

**Filter by Mode**

Receive only orchestrator or single-agent messages:

```python
def filter_orchestrators_only(tcp_sock):
    """Receive only orchestrator session updates"""
    filter_msg = {
        "type": "set_stream_filter",
        "session_id": None,
        "session_mode": "orchestrator"
    }
    tcp_sock.sendall((json.dumps(filter_msg) + "\n").encode())
```

**Reset Filter (Receive All)**

```python
def receive_all(tcp_sock):
    """Clear filter, receive all messages"""
    filter_msg = {
        "type": "set_stream_filter",
        "session_id": None,
        "session_mode": None
    }
    tcp_sock.sendall((json.dumps(filter_msg) + "\n").encode())
```

---

## Cross-Region Coordination

### Zone-Based Access Control

**Scenario:** UI agent needs type definition from core region

#### 1. Configure Zones at Startup

```bash
# UI agent with restricted zone
./eisen-core observe --port 0 \
  --agent-id ui-agent-001 \
  --session-id sess_ui_001 \
  --zone "src/ui/**" \
  --zone "shared/**" \
  -- opencode acp

# Core agent with its zone
./eisen-core observe --port 0 \
  --agent-id core-agent-002 \
  --session-id sess_core_001 \
  --zone "core/**" \
  --zone "shared/**" \
  -- opencode acp
```

#### 2. Monitor Blocked Access Events

```python
def handle_blocked_access(tcp_sock):
    """Listen for zone violations and route to appropriate agent"""
    file = tcp_sock.makefile('r')
    for line in file:
        msg = json.loads(line)
        if msg['type'] == 'blocked':
            agent_id = msg['agent_id']
            session_id = msg['session_id']
            path = msg['path']
            action = msg['action']
            
            print(f"Agent {agent_id} blocked from {action} {path}")
            
            # Route to agent with access to that path
            target_agent = find_agent_for_path(path)
            if target_agent:
                result = request_from_agent(target_agent, action, path)
                send_result_to_blocked_agent(agent_id, session_id, result)
```

#### 3. Implement Cross-Region Proxy

```python
class CrossRegionRouter:
    def __init__(self):
        self.agent_zones = {
            "ui-agent-001": ["src/ui/**", "shared/**"],
            "core-agent-002": ["core/**", "shared/**"],
        }
        self.agent_sockets = {}  # Map agent_id -> socket
    
    def find_agent_for_path(self, path):
        """Find agent with access to path"""
        import fnmatch
        for agent_id, patterns in self.agent_zones.items():
            if any(fnmatch.fnmatch(path, pattern) for pattern in patterns):
                return agent_id
        return None
    
    def handle_blocked_access(self, blocked_msg):
        """Route blocked request through authorized agent"""
        target_agent = self.find_agent_for_path(blocked_msg['path'])
        if not target_agent:
            return {"error": "No agent has access to this path"}
        
        # Send read request to target agent via ACP
        if blocked_msg['action'] == 'read':
            content = self.read_file_via_agent(
                target_agent,
                blocked_msg['path']
            )
            return {"content": content}
        elif blocked_msg['action'] == 'write':
            # Proxy write through authorized agent
            return self.write_file_via_agent(
                target_agent,
                blocked_msg['path'],
                blocked_msg.get('content')
            )
    
    def read_file_via_agent(self, agent_id, path):
        """Issue ACP read request to specific agent"""
        # Implementation depends on your ACP client library
        pass
```

### Orchestrator Aggregation

**Unified View Across Agents**

```python
def get_orchestrator_snapshot(tcp_sock, orch_session_id):
    """Request snapshot showing aggregated view of all providers"""
    request = {
        "type": "request_snapshot",
        "session_id": orch_session_id
    }
    tcp_sock.sendall((json.dumps(request) + "\n").encode())
    response = json.loads(tcp_sock.makefile('r').readline())
    
    # Snapshot contains merged nodes from all provider agents
    return response

# Usage
snapshot = get_orchestrator_snapshot(sock, "sess_orch_001")

# snapshot['nodes'] includes files from both ui-agent and core-agent
# with last-write-wins merge strategy based on timestamp_ms
```

**Conflict Resolution**

When multiple providers access same file, orchestrator uses:

1. **Heat**: Maximum across providers
2. **in_context**: True if any provider has it in context
3. **turn_accessed**: Maximum turn number
4. **last_action**: Last-write-wins by `timestamp_ms`, with tie-breaking:
   - Write action > Search action > Read action

Example merged node:
```json
{
  "path": "shared/types.ts",
  "heat": 0.8,
  "in_context": true,
  "last_action": "write",
  "turn_accessed": 5,
  "timestamp_ms": 1234567890456
}
```

---

## Token Usage Tracking

### Monitoring Context Window

```python
def handle_usage_messages(tcp_sock):
    """Track token consumption per session"""
    usage_history = {}
    
    file = tcp_sock.makefile('r')
    for line in file:
        msg = json.loads(line)
        if msg['type'] == 'usage':
            session_id = msg['session_id']
            usage_history.setdefault(session_id, []).append({
                'used': msg['used'],
                'size': msg['size'],
                'cost': msg.get('cost'),
                'timestamp': time.time()
            })
            
            # Detect compaction
            if len(usage_history[session_id]) >= 2:
                prev = usage_history[session_id][-2]
                curr = usage_history[session_id][-1]
                drop_ratio = 1.0 - (curr['used'] / prev['used'])
                if drop_ratio >= 0.5:
                    print(f"Compaction detected in {session_id}: {prev['used']} -> {curr['used']}")
```

### Cost Aggregation (Orchestrator)

For orchestrator sessions, usage is summed across providers:

```python
def calculate_orchestrator_cost(usage_msgs):
    """
    Orchestrator usage messages aggregate provider costs.
    
    Rules:
    - used_total = sum of provider used tokens
    - size_total = sum of provider context sizes
    - cost = sum if same currency, else None
    """
    total_used = sum(msg['used'] for msg in usage_msgs)
    total_size = sum(msg['size'] for msg in usage_msgs)
    
    costs = [msg.get('cost') for msg in usage_msgs if msg.get('cost')]
    if costs and all(c['currency'] == costs[0]['currency'] for c in costs):
        total_cost = {
            'amount': sum(c['amount'] for c in costs),
            'currency': costs[0]['currency']
        }
    else:
        total_cost = None
    
    return {
        'used': total_used,
        'size': total_size,
        'cost': total_cost
    }
```

---

## Advanced Patterns

### 1. Real-Time Conflict Detection

Detect when multiple agents edit same file:

```python
class ConflictDetector:
    def __init__(self):
        self.last_writers = {}  # path -> (agent_id, timestamp)
    
    def process_delta(self, delta):
        conflicts = []
        for update in delta['updates']:
            if update['last_action'] == 'write':
                path = update['path']
                prev = self.last_writers.get(path)
                
                if prev and prev['agent_id'] != delta['agent_id']:
                    # Different agent writing to same file
                    time_diff = update['timestamp_ms'] - prev['timestamp_ms']
                    if time_diff < 5000:  # Within 5 seconds
                        conflicts.append({
                            'path': path,
                            'agents': [prev['agent_id'], delta['agent_id']],
                            'time_diff_ms': time_diff
                        })
                
                self.last_writers[path] = {
                    'agent_id': delta['agent_id'],
                    'timestamp_ms': update['timestamp_ms']
                }
        
        return conflicts
```

### 2. Session Context Propagation

Share context items between sessions:

```python
def share_context_item(tcp_sock, from_session, to_session, item):
    """
    Copy context item from one session to another.
    
    item: {"type": "file", "uri": "file:///path/to/file.rs", "content": "..."}
    """
    rpc = {
        "type": "rpc",
        "id": f"share_{time.time()}",
        "method": "add_context_items",
        "params": {
            "agent_id": to_session['agent_id'],
            "session_id": to_session['session_id'],
            "items": [item]
        }
    }
    tcp_sock.sendall((json.dumps(rpc) + "\n").encode())
    response = json.loads(tcp_sock.makefile('r').readline())
    return response
```

### 3. Activity-Based Agent Routing

Route user queries to most active agent for a file:

```python
class ActivityRouter:
    def __init__(self):
        self.file_activity = {}  # path -> {agent_id: heat}
    
    def update_from_delta(self, delta):
        agent_id = delta['agent_id']
        for update in delta['updates']:
            path = update['path']
            self.file_activity.setdefault(path, {})[agent_id] = update['heat']
    
    def get_best_agent_for_file(self, path):
        """Return agent_id with highest activity for file"""
        if path not in self.file_activity:
            return None
        agents = self.file_activity[path]
        return max(agents, key=agents.get)
    
    def route_query(self, query_text, mentioned_files):
        """Route query to agent most familiar with mentioned files"""
        agent_scores = {}
        for path in mentioned_files:
            agent = self.get_best_agent_for_file(path)
            if agent:
                heat = self.file_activity[path].get(agent, 0)
                agent_scores[agent] = agent_scores.get(agent, 0) + heat
        
        if agent_scores:
            return max(agent_scores, key=agent_scores.get)
        return None
```

---

## Testing Integration

### Unit Test Example

```python
import unittest
import socket
import json
import subprocess
import time

class TestEisenCoreIntegration(unittest.TestCase):
    def setUp(self):
        """Start eisen-core process and connect"""
        self.proc = subprocess.Popen(
            ["./eisen-core", "observe", "--port", "0", "--", "opencode", "acp"],
            stderr=subprocess.PIPE,
            text=True
        )
        
        # Parse port from stderr
        for line in self.proc.stderr:
            if "eisen-core tcp port:" in line:
                self.port = int(line.split(":")[-1].strip())
                break
        
        time.sleep(0.5)  # Let server start
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect(("127.0.0.1", self.port))
        self.file = self.sock.makefile('r')
    
    def tearDown(self):
        self.sock.close()
        self.proc.terminate()
        self.proc.wait()
    
    def test_receive_initial_snapshot(self):
        """Should receive snapshot immediately on connect"""
        line = self.file.readline()
        msg = json.loads(line)
        self.assertEqual(msg['type'], 'snapshot')
        self.assertIn('nodes', msg)
        self.assertIn('seq', msg)
    
    def test_request_snapshot_roundtrip(self):
        """Should receive snapshot on explicit request"""
        # Read initial snapshot
        self.file.readline()
        
        # Request new snapshot
        request = {"type": "request_snapshot"}
        self.sock.sendall((json.dumps(request) + "\n").encode())
        
        line = self.file.readline()
        msg = json.loads(line)
        self.assertEqual(msg['type'], 'snapshot')
    
    def test_stream_filter(self):
        """Should filter messages by session"""
        # Read initial snapshot
        self.file.readline()
        
        # Set filter
        filter_msg = {
            "type": "set_stream_filter",
            "session_id": "test_session",
            "session_mode": None
        }
        self.sock.sendall((json.dumps(filter_msg) + "\n").encode())
        
        # Future messages should be filtered
        # (Would need to trigger agent activity to test fully)
```

---

## Performance Optimization

### Connection Pooling

For multiple UI clients:

```python
class EisenCoreConnectionPool:
    def __init__(self, port):
        self.port = port
        self.connections = []
        self.lock = threading.Lock()
    
    def get_connection(self):
        with self.lock:
            if self.connections:
                return self.connections.pop()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.connect(("127.0.0.1", self.port))
            return sock
    
    def return_connection(self, sock):
        with self.lock:
            self.connections.append(sock)
```

### Delta Batching

Reduce UI update frequency:

```python
class DeltaBatcher:
    def __init__(self, batch_interval=0.5):
        self.batch_interval = batch_interval
        self.pending_updates = {}
        self.last_flush = time.time()
    
    def process_delta(self, delta):
        """Accumulate deltas and flush periodically"""
        for update in delta['updates']:
            path = update['path']
            # Keep only most recent update per path
            self.pending_updates[path] = update
        
        for path in delta['removed']:
            self.pending_updates.pop(path, None)
        
        # Flush if interval elapsed
        if time.time() - self.last_flush >= self.batch_interval:
            return self.flush()
        return None
    
    def flush(self):
        """Return accumulated updates"""
        if not self.pending_updates:
            return None
        
        updates = list(self.pending_updates.values())
        self.pending_updates.clear()
        self.last_flush = time.time()
        return updates
```

---

## Troubleshooting

### Debug Logging

Enable detailed tracing:
```bash
RUST_LOG=debug ./eisen-core observe --port 0 -- opencode acp
```

Look for:
- `upstream ACP message` — Editor → Agent flow
- `downstream ACP message` — Agent → Editor flow
- `zone violation: blocked` — Access control triggers
- `forwarding delta to TCP client` — Broadcast events

### Common Issues

**Issue: Not receiving deltas**

Check:
1. Filter applied? Send `{"type":"set_stream_filter","session_id":null}`
2. Agent activity happening? Trigger file read/write
3. Socket still connected? Test with `{"type":"request_snapshot"}`

**Issue: Blocked access not routing**

Check:
1. Zone patterns correct? Use `**` for recursive match
2. Denied patterns overriding? Denied takes precedence
3. Listening for `blocked` messages in TCP stream?

**Issue: Session not persisted**

Check:
1. `$EISEN_DIR` writable? Default `~/.eisen`
2. `core_sessions.json` valid JSON?
3. RPC response has error? Check `response['error']`

---

## Summary

### Key Integration Points

1. **TCP Connection** — Single persistent socket for all updates
2. **RPC Protocol** — Session management via JSON-RPC
3. **Stream Filtering** — Per-session or per-mode message routing
4. **Zone Enforcement** — Automatic cross-region coordination
5. **Orchestrator Mode** — Multi-agent unified view

### Data Management Best Practices

- **Session Lifecycle**: Create → Set Active → Use → Close
- **Context Tracking**: Monitor `in_context` flag for relevance
- **Heat Decay**: Use for UI prominence (hot files highlighted)
- **Compaction Detection**: Expect context resets on large drops
- **Conflict Resolution**: Timestamp-based LWW with action priority

### Next Steps

1. Implement TCP client in orchestrator (Python)
2. Subscribe to `blocked` messages for cross-region routing
3. Create orchestrator sessions with provider lists
4. Render graph UI from snapshot/delta messages
5. Test zone enforcement with multiple agents

For detailed architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).
