use super::resources::get_resource_yaml;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffLine {
    pub line_type: String, // "add", "remove", "context", "header"
    pub content: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffResult {
    pub resource_name: String,
    pub resource_kind: String,
    pub namespace: String,
    pub lines: Vec<DiffLine>,
    pub additions: usize,
    pub deletions: usize,
    pub has_changes: bool,
}

fn compute_diff(old_text: &str, new_text: &str) -> Vec<DiffLine> {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();

    // Simple LCS-based diff
    let m = old_lines.len();
    let n = new_lines.len();

    // Build LCS table
    let mut lcs = vec![vec![0u32; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            if old_lines[i - 1] == new_lines[j - 1] {
                lcs[i][j] = lcs[i - 1][j - 1] + 1;
            } else {
                lcs[i][j] = lcs[i - 1][j].max(lcs[i][j - 1]);
            }
        }
    }

    // Backtrace to produce diff
    let mut result = Vec::new();
    let mut i = m;
    let mut j = n;
    let mut ops: Vec<(char, usize, usize, String)> = Vec::new();

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            ops.push((' ', i, j, old_lines[i - 1].to_string()));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || lcs[i][j - 1] >= lcs[i - 1][j]) {
            ops.push(('+', 0, j, new_lines[j - 1].to_string()));
            j -= 1;
        } else if i > 0 {
            ops.push(('-', i, 0, old_lines[i - 1].to_string()));
            i -= 1;
        }
    }

    ops.reverse();

    // Convert to DiffLine with context window
    let mut old_ln = 0usize;
    let mut new_ln = 0usize;

    for (op, _oi, _ni, content) in &ops {
        match op {
            ' ' => {
                old_ln += 1;
                new_ln += 1;
                result.push(DiffLine {
                    line_type: "context".to_string(),
                    content: content.clone(),
                    old_line: Some(old_ln),
                    new_line: Some(new_ln),
                });
            }
            '+' => {
                new_ln += 1;
                result.push(DiffLine {
                    line_type: "add".to_string(),
                    content: content.clone(),
                    old_line: None,
                    new_line: Some(new_ln),
                });
            }
            '-' => {
                old_ln += 1;
                result.push(DiffLine {
                    line_type: "remove".to_string(),
                    content: content.clone(),
                    old_line: Some(old_ln),
                    new_line: None,
                });
            }
            _ => {}
        }
    }

    result
}

#[tauri::command]
pub async fn diff_resources(
    context: String,
    namespace: String,
    kind: String,
    name1: String,
    name2: String,
) -> Result<DiffResult, String> {
    // Compare two resources of the same kind
    let yaml1 = get_resource_yaml(context.clone(), namespace.clone(), kind.clone(), name1.clone()).await?;
    let yaml2 = get_resource_yaml(context, namespace.clone(), kind.clone(), name2.clone()).await?;

    let lines = compute_diff(&yaml1, &yaml2);
    let additions = lines.iter().filter(|l| l.line_type == "add").count();
    let deletions = lines.iter().filter(|l| l.line_type == "remove").count();

    Ok(DiffResult {
        resource_name: format!("{} ↔ {}", name1, name2),
        resource_kind: kind,
        namespace,
        lines,
        additions,
        deletions,
        has_changes: additions > 0 || deletions > 0,
    })
}

#[tauri::command]
pub async fn diff_yaml(
    old_yaml: String,
    new_yaml: String,
    resource_name: String,
    resource_kind: String,
    namespace: String,
) -> Result<DiffResult, String> {
    let lines = compute_diff(&old_yaml, &new_yaml);
    let additions = lines.iter().filter(|l| l.line_type == "add").count();
    let deletions = lines.iter().filter(|l| l.line_type == "remove").count();

    Ok(DiffResult {
        resource_name,
        resource_kind,
        namespace,
        lines,
        additions,
        deletions,
        has_changes: additions > 0 || deletions > 0,
    })
}
