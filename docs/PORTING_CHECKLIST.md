# MCP Tool Porting Checklist

Port tools by risk and management value. Keep Python live until required parity is complete.

## Ported In Node Scaffold

- [x] `list_available_chatwoot_accounts`
- [x] `list_available_chatwoot_scope`
- [x] `get_cache_sync_status`
- [x] `get_resolved_conversation_volume_by_inbox`
- [x] `get_daily_resolved_conversation_volume`
- [x] `get_chatwoot_native_report`

## Next High-Value Ports

- [ ] `find_chatwoot_accounts`
- [ ] `find_chatwoot_inboxes`
- [ ] `get_chatwoot_native_inbox_breakdown`
- [ ] `generate_resolved_support_report_for_date_range`
- [ ] `compare_chatwoot_accounts`
- [ ] `get_agent_performance_report`
- [ ] `list_chatwoot_agents`
- [ ] `get_agent_sla_metrics`
- [ ] `get_slow_conversations`
- [ ] `get_resolved_conversations_with_unresolved_signals`
- [ ] `cluster_feature_requests`
- [ ] `rank_bug_reports_by_frequency`
- [ ] `get_pain_point_resolution_status`

## Semantic Search Ports

These need an embedding query strategy in Node. Options:
- call embedding service `/embed`
- use direct JS embedding runtime
- keep semantic search in Python until final migration

- [ ] `semantic_search_resolved_conversations`
- [ ] `find_similar_resolved_conversations`
- [ ] `find_similar_transcript_chunks`

## Remaining Tool Categories

Search/history:
- [ ] `keyword_search_resolved_conversations`
- [ ] `search_resolved_transcript_snippets`
- [ ] `get_resolved_conversation_context`
- [ ] `get_resolved_conversation_summary`
- [ ] `summarize_resolved_conversation_batch`
- [ ] `get_transcript_chunk_context`
- [ ] `get_resolved_conversation_outcome`

Issue analytics:
- [ ] `get_top_resolved_issue_labels`
- [ ] `get_resolved_issue_label_trends`
- [ ] `compare_resolved_issue_periods`
- [ ] `get_resolved_conversation_volume_by_channel`
- [ ] `get_resolved_conversation_volume_by_inbox_brand`
- [ ] `get_cached_conversation_volume_by_status`
- [ ] `get_emerging_resolved_issue_labels`
- [ ] `get_label_conversation_examples`

Sentiment/risk/customer:
- [ ] `get_resolved_sentiment_signal_report`
- [ ] `get_negative_friction_conversations`
- [ ] `get_frustration_signal_conversations`
- [ ] `get_churn_risk_signal_conversations`
- [ ] `get_escalation_signal_conversations`
- [ ] `get_customer_resolved_history`
- [ ] `get_customer_resolved_history_by_identity`
- [ ] `get_customer_unresolved_issue_signals`
- [ ] `get_repeat_customer_contacts`
- [ ] `get_vip_priority_conversations`
- [ ] `find_customers_by_exact_issue_keyword`

Agent/team:
- [ ] `get_agent_resolution_workload`
- [ ] `get_agent_label_mix`
- [ ] `get_agent_wrong_label_assignments`
- [ ] `get_agent_resolution_channel_mix`
- [ ] `generate_weekly_resolved_team_leader_summary`

Live read-only Chatwoot:
- [ ] `search_chatwoot_live`
- [ ] `list_live_chatwoot_agents`
- [ ] `list_chatwoot_inboxes`
- [ ] `list_chatwoot_teams`
- [ ] `list_chatwoot_labels`
- [ ] `search_chatwoot_contacts_live`

Reports:
- [ ] `generate_current_month_resolved_support_report`
- [ ] `generate_current_quarter_resolved_support_report`
- [ ] `get_first_response_time_report`
- [ ] `get_resolution_time_report`
