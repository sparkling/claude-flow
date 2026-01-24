//! DAG Operations
//!
//! Directed Acyclic Graph operations for bead dependency management.

use wasm_bindgen::prelude::*;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::algo::is_cyclic_directed;
use std::collections::{HashMap, HashSet, VecDeque};
use crate::BeadNode;

/// Check if the dependency graph has cycles
pub fn has_cycle_impl(beads_json: &str) -> Result<bool, JsValue> {
    let beads: Vec<BeadNode> = serde_json::from_str(beads_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {}", e)))?;

    let graph = build_graph(&beads);
    Ok(is_cyclic_directed(&graph))
}

/// Find nodes that are part of cycles
pub fn find_cycle_nodes_impl(beads_json: &str) -> Result<String, JsValue> {
    let beads: Vec<BeadNode> = serde_json::from_str(beads_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {}", e)))?;

    let cycle_nodes = find_cycle_nodes_internal(&beads);

    serde_json::to_string(&cycle_nodes)
        .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
}

/// Build adjacency list from beads
pub fn build_adjacency_impl(beads_json: &str) -> Result<String, JsValue> {
    let beads: Vec<BeadNode> = serde_json::from_str(beads_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {}", e)))?;

    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();

    for bead in &beads {
        adjacency.entry(bead.id.clone()).or_insert_with(Vec::new);
        for blocked in &bead.blocks {
            adjacency.entry(bead.id.clone())
                .or_insert_with(Vec::new)
                .push(blocked.clone());
        }
    }

    serde_json::to_string(&adjacency)
        .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
}

/// Get beads with no unresolved dependencies (ready to work on)
pub fn get_ready_beads_impl(beads_json: &str) -> Result<String, JsValue> {
    let beads: Vec<BeadNode> = serde_json::from_str(beads_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {}", e)))?;

    // Build set of closed beads
    let closed: HashSet<_> = beads.iter()
        .filter(|b| b.status == "closed")
        .map(|b| &b.id)
        .collect();

    // Find beads where all blockers are closed or empty
    let ready: Vec<String> = beads.iter()
        .filter(|b| b.status != "closed")
        .filter(|b| b.blocked_by.iter().all(|blocker| closed.contains(blocker)))
        .map(|b| b.id.clone())
        .collect();

    serde_json::to_string(&ready)
        .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
}

/// Compute execution levels (beads at same level can run in parallel)
pub fn compute_levels_impl(beads_json: &str) -> Result<String, JsValue> {
    let beads: Vec<BeadNode> = serde_json::from_str(beads_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {}", e)))?;

    let levels = compute_levels_internal(&beads);

    serde_json::to_string(&levels)
        .map_err(|e| JsValue::from_str(&format!("Serialize error: {}", e)))
}

/// Build a petgraph DiGraph from beads
pub fn build_graph(beads: &[BeadNode]) -> DiGraph<String, ()> {
    let mut graph: DiGraph<String, ()> = DiGraph::new();
    let mut node_map: HashMap<String, NodeIndex> = HashMap::new();

    // Add all nodes
    for bead in beads {
        let idx = graph.add_node(bead.id.clone());
        node_map.insert(bead.id.clone(), idx);
    }

    // Add edges (from blocker to blocked)
    for bead in beads {
        if let Some(&to_idx) = node_map.get(&bead.id) {
            for blocker in &bead.blocked_by {
                if let Some(&from_idx) = node_map.get(blocker) {
                    graph.add_edge(from_idx, to_idx, ());
                }
            }
        }
    }

    graph
}

/// Find nodes that participate in cycles using Tarjan's SCC algorithm
fn find_cycle_nodes_internal(beads: &[BeadNode]) -> Vec<String> {
    let mut id_to_index: HashMap<String, usize> = HashMap::new();
    let mut index_to_id: HashMap<usize, String> = HashMap::new();

    for (i, bead) in beads.iter().enumerate() {
        id_to_index.insert(bead.id.clone(), i);
        index_to_id.insert(i, bead.id.clone());
    }

    let n = beads.len();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];

    for bead in beads {
        if let Some(&from_idx) = id_to_index.get(&bead.id) {
            for blocked in &bead.blocks {
                if let Some(&to_idx) = id_to_index.get(blocked) {
                    adj[from_idx].push(to_idx);
                }
            }
        }
    }

    // Tarjan's SCC algorithm
    let mut index = 0;
    let mut indices: Vec<Option<usize>> = vec![None; n];
    let mut lowlinks: Vec<usize> = vec![0; n];
    let mut on_stack: Vec<bool> = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut sccs: Vec<Vec<usize>> = Vec::new();

    fn strongconnect(
        v: usize,
        adj: &[Vec<usize>],
        index: &mut usize,
        indices: &mut [Option<usize>],
        lowlinks: &mut [usize],
        on_stack: &mut [bool],
        stack: &mut Vec<usize>,
        sccs: &mut Vec<Vec<usize>>,
    ) {
        indices[v] = Some(*index);
        lowlinks[v] = *index;
        *index += 1;
        stack.push(v);
        on_stack[v] = true;

        for &w in &adj[v] {
            if indices[w].is_none() {
                strongconnect(w, adj, index, indices, lowlinks, on_stack, stack, sccs);
                lowlinks[v] = lowlinks[v].min(lowlinks[w]);
            } else if on_stack[w] {
                lowlinks[v] = lowlinks[v].min(indices[w].unwrap());
            }
        }

        if lowlinks[v] == indices[v].unwrap() {
            let mut scc = Vec::new();
            while let Some(w) = stack.pop() {
                on_stack[w] = false;
                scc.push(w);
                if w == v {
                    break;
                }
            }
            sccs.push(scc);
        }
    }

    for v in 0..n {
        if indices[v].is_none() {
            strongconnect(v, &adj, &mut index, &mut indices, &mut lowlinks, &mut on_stack, &mut stack, &mut sccs);
        }
    }

    // Find SCCs with more than one node (cycles)
    let mut cycle_nodes: Vec<String> = Vec::new();
    for scc in sccs {
        if scc.len() > 1 {
            for idx in scc {
                if let Some(id) = index_to_id.get(&idx) {
                    cycle_nodes.push(id.clone());
                }
            }
        }
    }

    cycle_nodes
}

/// Compute execution levels using BFS from sources
fn compute_levels_internal(beads: &[BeadNode]) -> HashMap<usize, Vec<String>> {
    let mut id_to_index: HashMap<String, usize> = HashMap::new();
    let mut in_degree: HashMap<String, usize> = HashMap::new();

    for bead in beads {
        id_to_index.insert(bead.id.clone(), 0);
        in_degree.insert(bead.id.clone(), bead.blocked_by.len());
    }

    let mut levels: HashMap<usize, Vec<String>> = HashMap::new();
    let mut level_map: HashMap<String, usize> = HashMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();

    // Start with nodes that have no dependencies
    for bead in beads {
        if bead.blocked_by.is_empty() {
            queue.push_back(bead.id.clone());
            level_map.insert(bead.id.clone(), 0);
            levels.entry(0).or_insert_with(Vec::new).push(bead.id.clone());
        }
    }

    while let Some(id) = queue.pop_front() {
        let current_level = *level_map.get(&id).unwrap_or(&0);

        // Find beads that this one blocks
        for bead in beads {
            if bead.blocked_by.contains(&id) && !level_map.contains_key(&bead.id) {
                // Check if all dependencies are processed
                let all_deps_processed = bead.blocked_by.iter()
                    .all(|dep| level_map.contains_key(dep));

                if all_deps_processed {
                    let max_dep_level = bead.blocked_by.iter()
                        .filter_map(|dep| level_map.get(dep))
                        .max()
                        .copied()
                        .unwrap_or(0);

                    let new_level = max_dep_level + 1;
                    level_map.insert(bead.id.clone(), new_level);
                    levels.entry(new_level).or_insert_with(Vec::new).push(bead.id.clone());
                    queue.push_back(bead.id.clone());
                }
            }
        }
    }

    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cycle_detection() {
        // Create a cycle: a -> b -> c -> a
        let beads = vec![
            BeadNode {
                id: "a".to_string(),
                title: "A".to_string(),
                status: "open".to_string(),
                priority: 0,
                blocked_by: vec!["c".to_string()],
                blocks: vec!["b".to_string()],
                duration: None,
            },
            BeadNode {
                id: "b".to_string(),
                title: "B".to_string(),
                status: "open".to_string(),
                priority: 0,
                blocked_by: vec!["a".to_string()],
                blocks: vec!["c".to_string()],
                duration: None,
            },
            BeadNode {
                id: "c".to_string(),
                title: "C".to_string(),
                status: "open".to_string(),
                priority: 0,
                blocked_by: vec!["b".to_string()],
                blocks: vec!["a".to_string()],
                duration: None,
            },
        ];

        let beads_json = serde_json::to_string(&beads).unwrap();
        assert!(has_cycle_impl(&beads_json).unwrap());
    }

    #[test]
    fn test_ready_beads() {
        let beads = vec![
            BeadNode {
                id: "a".to_string(),
                title: "A".to_string(),
                status: "closed".to_string(),
                priority: 0,
                blocked_by: vec![],
                blocks: vec!["b".to_string()],
                duration: None,
            },
            BeadNode {
                id: "b".to_string(),
                title: "B".to_string(),
                status: "open".to_string(),
                priority: 0,
                blocked_by: vec!["a".to_string()],
                blocks: vec!["c".to_string()],
                duration: None,
            },
            BeadNode {
                id: "c".to_string(),
                title: "C".to_string(),
                status: "open".to_string(),
                priority: 0,
                blocked_by: vec!["b".to_string()],
                blocks: vec![],
                duration: None,
            },
        ];

        let beads_json = serde_json::to_string(&beads).unwrap();
        let result = get_ready_beads_impl(&beads_json).unwrap();
        let ready: Vec<String> = serde_json::from_str(&result).unwrap();

        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0], "b");
    }
}
