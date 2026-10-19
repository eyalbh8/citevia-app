-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "names" TEXT[],
    "domains" TEXT[],
    "knowledge_sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sitemap_url" TEXT,
    "case_studies_source_url" TEXT,
    "case_studies" JSONB NOT NULL DEFAULT '[]',
    "post_guidelines" JSONB,
    "project_data" JSONB NOT NULL DEFAULT '{}',
    "skip_post_images" BOOLEAN NOT NULL DEFAULT false,
    "generate_posts_on_recommendation" BOOLEAN NOT NULL DEFAULT true,
    "logo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "is_under_agency" BOOLEAN NOT NULL DEFAULT false,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "parent_account_id" UUID,
    "project_account_id" UUID,
    "about" TEXT,
    "industry_category" TEXT,
    "sub_industry_category" TEXT,
    "company_country" VARCHAR(2),
    "reporting_excluded" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT,
    "key_features" TEXT[],
    "tone_of_voice" TEXT[],
    "values" TEXT[],
    "personality" TEXT[],
    "target_audience" TEXT[],
    "socials" JSONB,
    "brand_colors" JSONB,
    "make_dup_scans" INTEGER NOT NULL DEFAULT 0,
    "onboarding_path" TEXT DEFAULT 'HAS_DOMAIN',

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_center_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sequence" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "data" JSONB NOT NULL,
    "coverage" TEXT NOT NULL DEFAULT 'verified',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_center_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_center_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "data_center_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_center_projections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "data_center_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_center_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "last_successful_sync_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "data_center_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gsc_keyword_syncs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "site_url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "sync_token" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "latest_date" DATE,

    CONSTRAINT "gsc_keyword_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gsc_keyword_days" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "site_url" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keyword_count" INTEGER NOT NULL,
    "impressions" DOUBLE PRECISION NOT NULL,
    "position_sum" DOUBLE PRECISION NOT NULL,
    "limited" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "gsc_keyword_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gsc_keyword_daily" (
    "id" UUID NOT NULL,
    "day_id" UUID NOT NULL,
    "query_hash" CHAR(64) NOT NULL,
    "query" TEXT NOT NULL,
    "clicks" DOUBLE PRECISION NOT NULL,
    "impressions" DOUBLE PRECISION NOT NULL,
    "position_sum" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "gsc_keyword_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_websites" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "content_config" JSONB NOT NULL,
    "slug" TEXT,
    "template_version" TEXT,
    "source_gcs_path" TEXT,
    "build_gcs_path" TEXT,
    "preview_url" TEXT,
    "cloud_run_job_execution_id" TEXT,
    "build_logs_gcs_key" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generated_websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_orders" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "registrar" TEXT NOT NULL DEFAULT 'GCP_CLOUD_DOMAINS',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purchase_price_cents" INTEGER,
    "renewal_price_cents" INTEGER,
    "years" INTEGER NOT NULL DEFAULT 1,
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "registrant_contact" JSONB,
    "gcp_registration_id" TEXT,
    "cloud_dns_zone_id" TEXT,
    "certificate_manager_cert_id" TEXT,
    "certificate_map_entry_id" TEXT,
    "stripe_invoice_item_id" TEXT,
    "last_error" TEXT,
    "purchased_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "domain_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_edit_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "generated_website_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "website_edit_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_edit_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "diff_summary" TEXT,
    "resulting_build_gcs_path" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_edit_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_workflows" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "recommendation_id" UUID,
    "recommendation_version_id" UUID,
    "template_id" TEXT NOT NULL,
    "destination" TEXT NOT NULL DEFAULT 'ONSITE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "current_stage" TEXT NOT NULL DEFAULT 'CONFIGURATION',
    "topic_id" UUID,
    "prompt_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cited_page_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "brand_kit" JSONB,
    "audience" TEXT,
    "instructions" TEXT,
    "selected_title" TEXT,
    "selected_title_kind" TEXT,
    "title" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_generation_runs" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "generation_index" INTEGER NOT NULL DEFAULT 1,
    "inputs_hash" TEXT NOT NULL,
    "model" TEXT,
    "prompt_version" TEXT,
    "output" JSONB,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_briefs" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "outline" JSONB NOT NULL,
    "sections" JSONB NOT NULL,
    "metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_assets" (
    "recommendation_version_id" UUID,
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "body_html" TEXT NOT NULL,
    "focus_keyword" TEXT,
    "slug" TEXT,
    "meta_title" TEXT,
    "meta_description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "schema_json_ld" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "published_url" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_settings" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "scan_period" INTEGER,
    "ai_engines" JSONB[],
    "regions" TEXT[],
    "competitors_names" JSONB NOT NULL,
    "suggested_competitors_names" JSONB,
    "pixel_id" TEXT,
    "scan_schedule_time" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "watched_onboard_video" TIMESTAMP(3),
    "visited_setup_steps" JSONB,
    "prompt_limit" INTEGER,
    "region_limit" INTEGER,
    "members_limit" INTEGER DEFAULT 2,
    "scan_interval_limit" INTEGER,
    "stripe_customer_id" TEXT,
    "paying_customer" TEXT,
    "social_media_provider_tokens" JSONB,
    "post_creation_limit" INTEGER,
    "referral_code" TEXT,
    "white_label_logo_small" TEXT,
    "white_label_logo_big" TEXT,
    "insight_limit" INTEGER DEFAULT 0,
    "generate_weekly_insights" BOOLEAN NOT NULL DEFAULT false,
    "daily_recommendation_mode" TEXT NOT NULL DEFAULT 'OFF',
    "automated_publish_posts" JSONB,
    "notification_preferences" JSONB,
    "appsumo_plan_tier" INTEGER,
    "mcp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "custom_brand_style_enabled" BOOLEAN NOT NULL DEFAULT false,
    "api_access_enabled" BOOLEAN NOT NULL DEFAULT false,
    "site_audit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sso_saml_soc2_enabled" BOOLEAN NOT NULL DEFAULT false,
    "crm_lead" JSONB,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_profiles" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "zernio_profile_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BRAND',
    "owner_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "zernio_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_social_connections" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "zernio_profile_record_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "zernio_account_id" TEXT NOT NULL,
    "external_account_id" TEXT,
    "username" TEXT,
    "display_name" TEXT,
    "profile_image" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "kind" TEXT NOT NULL DEFAULT 'SCHEDULING',
    "owner_user_id" UUID,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "publisher_connection_id" UUID,
    "engagement_actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "engagement_next_at" TIMESTAMPTZ(3),

    CONSTRAINT "zernio_social_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_webhook_events" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "account_id" UUID,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zernio_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_engagements" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "target_urn" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reaction_type" TEXT,
    "message" TEXT,
    "external_id" TEXT,
    "error_code" TEXT,
    "error" TEXT,
    "post_id" UUID,
    "performed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "linkedin_engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_profile_groups" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#533899',
    "auto_amplify" BOOLEAN NOT NULL DEFAULT true,
    "publisher_connection_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_profile_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_profile_group_members" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_profile_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_engagements" (
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(3),
    "lease_token" TEXT,
    "dispatched_at" TIMESTAMPTZ(3),
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "post_id" UUID,
    "target_post_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "external_id" TEXT,
    "error_code" TEXT,
    "error" TEXT,
    "source" TEXT NOT NULL DEFAULT 'GROUP_AMPLIFY',
    "performed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sent_notifications" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "recipient_emails" TEXT[],
    "subject" TEXT,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "html_content" TEXT,
    "text_content" TEXT,
    "error_message" TEXT,
    "metadata" JSONB,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sent_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_email_templates" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html_body" TEXT NOT NULL,
    "sample_html_body" TEXT,
    "visit_path" TEXT,
    "required_keys" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "referral_code" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_subscriptions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL DEFAULT 'SYSTEM',
    "stripe_subscription_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trial_start_date" TIMESTAMP(3),
    "trial_end_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "cancel_at" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL,
    "canceled_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3),
    "quantity" INTEGER NOT NULL,
    "default_payment_method" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appsumo_plans" (
    "id" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "branded_plan" TEXT NOT NULL,
    "deal_access_duration" TEXT NOT NULL DEFAULT 'Lifetime',
    "lifetime_price_usd_cents" INTEGER NOT NULL,
    "prompt_limit" INTEGER NOT NULL,
    "insight_limit" INTEGER NOT NULL,
    "region_limit" INTEGER NOT NULL,
    "members_limit" INTEGER NOT NULL,
    "scan_interval_limit" INTEGER NOT NULL DEFAULT 0,
    "ai_engines" JSONB[],
    "has_mcp" BOOLEAN NOT NULL DEFAULT false,
    "has_custom_brand_style" BOOLEAN NOT NULL DEFAULT false,
    "has_api_access" BOOLEAN NOT NULL DEFAULT false,
    "has_site_audit" BOOLEAN NOT NULL DEFAULT false,
    "has_sso_saml_soc2" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appsumo_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appsumo_licenses" (
    "id" UUID NOT NULL,
    "license_key" TEXT NOT NULL,
    "previous_license_key" TEXT,
    "parent_license_key" TEXT,
    "license_status" TEXT NOT NULL DEFAULT 'inactive',
    "last_event" TEXT,
    "tier" INTEGER,
    "partner_plan_name" TEXT,
    "unit_quantity" INTEGER,
    "raw_metadata" JSONB,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "last_event_at" TIMESTAMPTZ(3),
    "appsumo_created_at" TIMESTAMPTZ(3),
    "account_id" UUID,
    "claimed_by_user_id" UUID,
    "claimed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appsumo_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appsumo_webhook_events" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "license_key" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "event_timestamp" TIMESTAMPTZ(3),
    "appsumo_created_at" TIMESTAMPTZ(3),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appsumo_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appsumo_oauth_claims" (
    "id" UUID NOT NULL,
    "claim_token_hash" VARCHAR(64) NOT NULL,
    "license_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "claimed_by_user_id" UUID,
    "account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appsumo_oauth_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_cancellation_feedback" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "account_subscription_id" UUID,
    "stripe_subscription_id" TEXT NOT NULL,
    "user_id" UUID,
    "user_email" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "offer" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_cancellation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "last_name" TEXT,
    "is_system_admin" BOOLEAN NOT NULL DEFAULT false,
    "can_view_data_center" BOOLEAN NOT NULL DEFAULT false,
    "reporting_excluded" BOOLEAN NOT NULL DEFAULT false,
    "is_agency" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "roles" TEXT[],
    "last_visit" TIMESTAMPTZ(3),
    "last_insights_visit" TIMESTAMPTZ(3),
    "team_profile" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_team_roles" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "desc" TEXT NOT NULL DEFAULT '',
    "color" VARCHAR(7) NOT NULL,
    "base" VARCHAR(80) NOT NULL,
    "permissions" JSONB NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_team_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" VARCHAR(32) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['mcp:full']::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "last_used_ip" TEXT,

    CONSTRAINT "mcp_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_access_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "user_email" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "project_account_id" UUID,
    "is_workspace" BOOLEAN NOT NULL DEFAULT false,
    "method" VARCHAR(16) NOT NULL,
    "path" TEXT NOT NULL,

    CONSTRAINT "admin_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_audit_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mcp_api_key_id" UUID,
    "account_id" UUID,
    "user_id" UUID,
    "key_prefix" VARCHAR(32),
    "http_method" VARCHAR(16) NOT NULL,
    "json_rpc_method" VARCHAR(64),
    "tool_name" VARCHAR(128),
    "resource_uri" TEXT,
    "resolved_path" TEXT,
    "request_params" JSONB,
    "outcome" VARCHAR(32) NOT NULL,
    "blocked_reason" VARCHAR(64),
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "upstream_http_status" INTEGER,
    "response_bytes" INTEGER,
    "record_count" INTEGER,
    "client_ip" VARCHAR(128),
    "request_origin" VARCHAR(512),
    "referer" VARCHAR(1024),
    "user_agent" VARCHAR(1024),
    "inferred_mcp_client" VARCHAR(32),

    CONSTRAINT "mcp_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" UUID NOT NULL,
    "client_id" VARCHAR(128) NOT NULL,
    "client_secret_hash" VARCHAR(64),
    "redirect_uris" TEXT[],
    "client_name" TEXT,
    "token_endpoint_auth_method" VARCHAR(32),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" UUID NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code_challenge" VARCHAR(512) NOT NULL,
    "code_challenge_method" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_tokens" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "mcp_key_encrypted" TEXT NOT NULL,
    "mcp_api_key_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ratingscore" INTEGER NOT NULL,
    "me_in_prompt" BOOLEAN NOT NULL,
    "topic_id" UUID NOT NULL,
    "regions" TEXT[],
    "language" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "generation_id" UUID,
    "avg_visibility" INTEGER NOT NULL DEFAULT 0,
    "avg_sentiment_score" INTEGER NOT NULL DEFAULT 0,
    "sentiment_breakdown" JSONB,
    "volume" INTEGER NOT NULL DEFAULT -1,
    "tags" JSONB,
    "stage" TEXT,
    "level" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "site" TEXT,
    "domain" TEXT,
    "advantage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "volume" INTEGER NOT NULL DEFAULT -1,
    "priority" INTEGER NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regions" (
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT,
    "city" TEXT,
    "locale" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "proxy_urls" TEXT[],

    CONSTRAINT "regions_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "task_index" INTEGER,
    "run_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "total_tasks" INTEGER,
    "account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_step" INTEGER NOT NULL DEFAULT 1,
    "total_prompts" INTEGER,
    "prompts_succeeded" INTEGER DEFAULT 0,
    "prompts_failed" INTEGER DEFAULT 0,
    "region_name" TEXT NOT NULL,
    "prompt_ids" TEXT[],
    "dup_task_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_batches" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "provider_batch_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "model" TEXT NOT NULL,
    "manifest_hash" TEXT NOT NULL,
    "request_count" INTEGER NOT NULL,
    "context" JSONB NOT NULL,
    "error_code" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "next_poll_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_batch_items" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "prompt_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "request_params" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "raw_result" JSONB,
    "usage" JSONB,
    "error_code" TEXT,
    "received_at" TIMESTAMPTZ(3),
    "ingested_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "prompt_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "is_company_in_prompt" BOOLEAN NOT NULL,
    "prompt_type" TEXT NOT NULL,
    "prompt_ranking" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "original_entity" TEXT NOT NULL,
    "reason" TEXT,
    "linkable" BOOLEAN NOT NULL,
    "company_sources" JSONB[],
    "company_site_url" TEXT,
    "company_domain" TEXT,
    "feel" TEXT,
    "url_sources" JSONB[],
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "scan_id" UUID NOT NULL,
    "region" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT,
    "city" TEXT,

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_responses" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "task_id" UUID,
    "topic_id" UUID,
    "prompt_id" UUID,
    "scan_id" UUID,
    "purpose" TEXT NOT NULL DEFAULT 'LLM_SCAN',
    "response" TEXT,
    "json_response" JSONB,
    "sources" JSONB[],
    "model" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "region" TEXT,
    "country" TEXT,
    "state" TEXT,
    "city" TEXT,
    "usage" JSONB,
    "brightdata_job_id" TEXT,
    "s3_key" TEXT,
    "failed_reason" TEXT,
    "dup_response_id" UUID,
    "related_response_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "provider" TEXT NOT NULL,
    "visibility" INTEGER NOT NULL DEFAULT 0,
    "response_rank" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prompt_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "domain_type" TEXT,
    "industry" TEXT,
    "region" TEXT,
    "last_classified" TIMESTAMPTZ(3),
    "classification_source" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_marketplace_sites" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "logo_url" TEXT,
    "favicon_url" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customer_price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "original_currency" TEXT,
    "original_price" INTEGER,
    "dr" INTEGER,
    "traffic" INTEGER,
    "origin" TEXT,
    "publisher" TEXT,
    "source_file" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "third_party_site_id" TEXT,
    "config" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "article_marketplace_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_marketplace_source_matches_cache" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "matches" JSONB NOT NULL DEFAULT '[]',
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "checked_source_domain_count" INTEGER NOT NULL DEFAULT 0,
    "last_scan_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "article_marketplace_source_matches_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_token_packs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stripe_product_id" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "article_token_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_publications" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "user_id" UUID,
    "site_id" UUID NOT NULL,
    "prompt_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topic_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "image_credit" TEXT,
    "article_word_file_url" TEXT,
    "tokens_cost" INTEGER NOT NULL,
    "customer_price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "published_url" TEXT,
    "third_party_row_key" TEXT,
    "third_party_article_id" TEXT,
    "third_party_response" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "article_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_token_transactions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "token_pack_id" UUID,
    "article_publication_id" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tokens" INTEGER NOT NULL,
    "balance_after" INTEGER,
    "stripe_checkout_session_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "article_token_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "engine_version" TEXT,
    "action_kind" TEXT,
    "target_url" TEXT,
    "channel" TEXT,
    "priority_score" DOUBLE PRECISION,
    "confidence" TEXT,
    "effort" TEXT,
    "fingerprint" TEXT,
    "current_version_id" UUID,
    "last_validated_at" TIMESTAMPTZ(3),
    "snoozed_until" TIMESTAMPTZ(3),
    "implementation_evidence" JSONB,
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "prompt_id" UUID,
    "batch_id" UUID,
    "type" TEXT NOT NULL,
    "effectiveness" TEXT NOT NULL,
    "target_keywords" TEXT[],
    "insight" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "topic" TEXT,
    "easy_to_do" BOOLEAN NOT NULL DEFAULT false,
    "trackable" BOOLEAN NOT NULL DEFAULT true,
    "due_week" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'TO_DO',

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_recommendations" (
    "id" UUID NOT NULL,
    "recommendation_id" UUID,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "urls" TEXT[],
    "total_appearances_after_implementation" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT,
    "content_type" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "topic_id" UUID,
    "prompt_id" UUID,
    "lifecycle_status" TEXT NOT NULL DEFAULT 'published',
    "first_crawled_at" TIMESTAMPTZ(3),
    "first_cited_at" TIMESTAMPTZ(3),
    "last_cited_at" TIMESTAMPTZ(3),
    "days_to_first_citation" INTEGER,
    "citations_prev_period" INTEGER NOT NULL DEFAULT 0,
    "lift_before" INTEGER,
    "lift_after" INTEGER,
    "state_computed_at" TIMESTAMPTZ(3),

    CONSTRAINT "tracked_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_recommendation_links" (
    "id" UUID NOT NULL,
    "tracked_recommendation_id" UUID NOT NULL,
    "recommendation_id" UUID,
    "post_id" UUID,

    CONSTRAINT "tracked_recommendation_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "dup_scan_id" UUID,
    "scheduled_by" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grouped_competitors" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "relative_url_regex" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_scans" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "submitted_by" TEXT NOT NULL,
    "target_url" TEXT,
    "competitor_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pages_scanned" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "page_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_scan_results" (
    "id" UUID NOT NULL,
    "page_scan_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "geo_score" INTEGER NOT NULL DEFAULT 0,
    "signals" JSONB,
    "recommendations" JSONB NOT NULL DEFAULT '[]',
    "competitor_gaps" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_scan_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_settings" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "used_step" TEXT NOT NULL,
    "input_message" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "distribution_planned_at" TIMESTAMPTZ(3),
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "social_media_provider" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[],
    "focus_keyphrase" TEXT,
    "slug" TEXT,
    "meta_description" TEXT,
    "read_time" INTEGER,
    "images_url" TEXT[],
    "youtube_url" TEXT,
    "visit_site" TEXT,
    "state" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "ai_model" TEXT NOT NULL,
    "ai_provider" TEXT NOT NULL,
    "ai_style" TEXT,
    "post_id_in_social_media_provider" TEXT,
    "zernio_post_id" TEXT,
    "unsplash_photo_id" TEXT,
    "unsplash_photographer_name" TEXT,
    "unsplash_photographer_username" TEXT,
    "unsplash_download_location" TEXT,
    "published_url" TEXT,
    "source_url" TEXT,
    "source_post_id" TEXT,
    "publish_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "recommendation_id" UUID,
    "recommendation_version_id" UUID,
    "appearances_count" INTEGER NOT NULL DEFAULT 0,
    "visibility_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "schemas_included" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "social_media_metrics" JSONB DEFAULT '{}',
    "content_metadata" JSONB NOT NULL DEFAULT '{}',
    "author_user_id" UUID,
    "publisher_connection_id" UUID,
    "engagement_planned_at" TIMESTAMPTZ(3),
    "publication_command" JSONB,
    "publication_lease_token" TEXT,
    "publication_lease_until" TIMESTAMPTZ(3),
    "publication_error" TEXT,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_ideas" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "author_user_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "converted_post_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_draft_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "user_id" UUID,
    "prompt_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "input_text" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_draft_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_approvals" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comments" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "comment" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_activities" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_notifications" (
    "source_key" TEXT,
    "delivery_planned_at" TIMESTAMPTZ(3),
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "post_id" UUID,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "via" TEXT[] DEFAULT ARRAY['inapp']::TEXT[],
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_requests" (
    "id" TEXT NOT NULL,
    "feature_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "async_jobs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,

    CONSTRAINT "async_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "tracker_version" TEXT NOT NULL DEFAULT 'v',
    "account_id" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "referrer" TEXT,
    "user_agent" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "bot_name" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "device" TEXT,
    "screen" TEXT,
    "platform" TEXT,
    "language" TEXT,
    "country" TEXT,
    "city" TEXT,
    "region" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloudflare_analytics" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "zone_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER,
    "bot_detection_id" INTEGER,
    "bot_name" TEXT,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "top_paths" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cloudflare_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_sources" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "original_table" TEXT,
    "original_id" TEXT,
    "language" TEXT,
    "title" TEXT,
    "url" TEXT,
    "is_user_provided" BOOLEAN NOT NULL DEFAULT false,
    "authority_score" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "ingestion_status" TEXT,
    "last_ingested_at" TIMESTAMPTZ(3),
    "ingestion_error" TEXT,
    "chunks_ingested" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embedding_chunks" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "content_source_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "authority_score" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "embedding_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_chunk_usage" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_chunk_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color_row" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audiences" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "age_range" TEXT,
    "education_level" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zernio_connect_sessions" (
    "id" VARCHAR(64) NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "account_id" UUID NOT NULL,
    "initiating_user_id" UUID,
    "encrypted_payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zernio_connect_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ui_page_cache" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "ui_page" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "data_version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "computed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "cache_hits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ui_page_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_connections" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "workspace_name" TEXT NOT NULL,
    "bot_token" TEXT NOT NULL,
    "bot_user_id" TEXT NOT NULL,
    "authed_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "slack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_audit_logs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "params" JSONB,
    "outcome" TEXT NOT NULL,
    "error_msg" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assistant_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_assistant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assistant_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actions" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_announcements" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "release_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_announcement_slides" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "image_url" TEXT,
    "cta_label" TEXT,
    "cta_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "release_announcement_slides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_announcement_views" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_announcement_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_runs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "project_account_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "evidence_cutoff" TIMESTAMPTZ(3) NOT NULL,
    "engine_version" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "refresh_attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "input_hash" TEXT,
    "packet" JSONB,
    "synthesis" JSONB,
    "coverage" JSONB,
    "usage" JSONB,
    "budget_reserved" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "recommendation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_project_budgets" (
    "id" UUID NOT NULL,
    "project_account_id" UUID NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "reserved_urls" INTEGER NOT NULL DEFAULT 0,
    "reserved_candidates" INTEGER NOT NULL DEFAULT 0,
    "reserved_calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "recommendation_project_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_evidence_sources" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "url" TEXT,
    "kind" TEXT NOT NULL,
    "last_checked_at" TIMESTAMPTZ(3) NOT NULL,
    "last_fetch_status" TEXT NOT NULL,
    "current_content_hash" TEXT,

    CONSTRAINT "recommendation_evidence_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_evidence_snapshots" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "content" JSONB NOT NULL,

    CONSTRAINT "recommendation_evidence_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_versions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "run_id" UUID,
    "input_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_delivery_jobs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "recipient_user_id" UUID,
    "post_id" UUID,
    "notification_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "provider_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_mention_reads" (
    "account_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "mention_id" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_mention_reads_pkey" PRIMARY KEY ("account_id","user_id","connection_id","mention_id")
);

-- CreateTable
CREATE TABLE "ops_runs" (
    "id" UUID NOT NULL,
    "parentId" UUID,
    "accountId" UUID,
    "projectId" UUID,
    "billingOwnerId" UUID,
    "process" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "outputs" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,

    CONSTRAINT "ops_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_usage" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "billingAccount" TEXT NOT NULL DEFAULT 'default',
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'standard',
    "requestId" TEXT,
    "retryIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "units" JSONB,
    "coverage" TEXT NOT NULL DEFAULT 'partial',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "amountMinor" DECIMAL(30,12),
    "currency" TEXT,
    "priceId" UUID,
    "pricedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ops_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_prices" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "billingAccount" TEXT NOT NULL DEFAULT 'default',
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rates" JSONB NOT NULL,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_sources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "billingAccount" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    "leaseToken" TEXT,
    "freshnessHours" INTEGER NOT NULL DEFAULT 48,
    "revision" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ops_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_bills" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "billingAccount" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "resource" TEXT,
    "environment" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "projectId" UUID,
    "currency" TEXT NOT NULL,
    "amountMinor" DECIMAL(30,12) NOT NULL,
    "chargeType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_allocations" (
    "id" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "amountMinor" DECIMAL(30,12) NOT NULL,
    "driver" DECIMAL(30,12) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_policies" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_incidents" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 1,
    "recoveries" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedBy" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ops_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_audit" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_snapshots" (
    "id" UUID NOT NULL,
    "filterHash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ops_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_feature_flags" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "account_feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_project_account_id_idx" ON "accounts"("project_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_center_records_sequence_key" ON "data_center_records"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "data_center_records_key_key" ON "data_center_records"("key");

-- CreateIndex
CREATE INDEX "data_center_records_kind_occurred_at_idx" ON "data_center_records"("kind", "occurred_at");

-- CreateIndex
CREATE INDEX "data_center_records_kind_entity_key_occurred_at_idx" ON "data_center_records"("kind", "entity_key", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "data_center_events_key_key" ON "data_center_events"("key");

-- CreateIndex
CREATE INDEX "data_center_events_status_next_attempt_at_idx" ON "data_center_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "data_center_projections_key_key" ON "data_center_projections"("key");

-- CreateIndex
CREATE UNIQUE INDEX "data_center_jobs_key_key" ON "data_center_jobs"("key");

-- CreateIndex
CREATE INDEX "data_center_jobs_status_next_attempt_at_idx" ON "data_center_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "gsc_keyword_syncs_account_id_site_url_key" ON "gsc_keyword_syncs"("account_id", "site_url");

-- CreateIndex
CREATE UNIQUE INDEX "gsc_keyword_days_account_id_site_url_date_key" ON "gsc_keyword_days"("account_id", "site_url", "date");

-- CreateIndex
CREATE INDEX "gsc_keyword_daily_query_hash_day_id_idx" ON "gsc_keyword_daily"("query_hash", "day_id");

-- CreateIndex
CREATE UNIQUE INDEX "gsc_keyword_daily_day_id_query_hash_key" ON "gsc_keyword_daily"("day_id", "query_hash");

-- CreateIndex
CREATE UNIQUE INDEX "generated_websites_account_id_key" ON "generated_websites"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "generated_websites_slug_key" ON "generated_websites"("slug");

-- CreateIndex
CREATE INDEX "domain_orders_account_id_idx" ON "domain_orders"("account_id");

-- CreateIndex
CREATE INDEX "website_edit_sessions_account_id_idx" ON "website_edit_sessions"("account_id");

-- CreateIndex
CREATE INDEX "website_edit_messages_session_id_idx" ON "website_edit_messages"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_workflows_recommendation_version_id_key" ON "content_workflows"("recommendation_version_id");

-- CreateIndex
CREATE INDEX "content_workflows_account_id_updated_at_idx" ON "content_workflows"("account_id", "updated_at");

-- CreateIndex
CREATE INDEX "content_workflows_account_id_status_idx" ON "content_workflows"("account_id", "status");

-- CreateIndex
CREATE INDEX "content_generation_runs_workflow_id_created_at_idx" ON "content_generation_runs"("workflow_id", "created_at");

-- CreateIndex
CREATE INDEX "content_generation_runs_inputs_hash_created_at_idx" ON "content_generation_runs"("inputs_hash", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_briefs_workflow_id_key" ON "content_briefs"("workflow_id");

-- CreateIndex
CREATE INDEX "content_assets_workflow_id_created_at_idx" ON "content_assets"("workflow_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_assets_workflow_id_version_key" ON "content_assets"("workflow_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "account_settings_account_id_key" ON "account_settings"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_settings_stripe_customer_id_key" ON "account_settings"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "account_settings_account_id_idx" ON "account_settings"("account_id");

-- CreateIndex
CREATE INDEX "account_settings_appsumo_plan_tier_idx" ON "account_settings"("appsumo_plan_tier");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_profiles_zernio_profile_id_key" ON "zernio_profiles"("zernio_profile_id");

-- CreateIndex
CREATE INDEX "zernio_profiles_account_id_kind_idx" ON "zernio_profiles"("account_id", "kind");

-- CreateIndex
CREATE INDEX "zernio_profiles_owner_user_id_idx" ON "zernio_profiles"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_social_connections_zernio_account_id_key" ON "zernio_social_connections"("zernio_account_id");

-- CreateIndex
CREATE INDEX "zernio_social_connections_account_id_publisher_connection_i_idx" ON "zernio_social_connections"("account_id", "publisher_connection_id");

-- CreateIndex
CREATE INDEX "zernio_social_connections_account_id_provider_status_idx" ON "zernio_social_connections"("account_id", "provider", "status");

-- CreateIndex
CREATE INDEX "zernio_social_connections_account_id_provider_is_default_idx" ON "zernio_social_connections"("account_id", "provider", "is_default");

-- CreateIndex
CREATE INDEX "zernio_social_connections_account_id_kind_status_idx" ON "zernio_social_connections"("account_id", "kind", "status");

-- CreateIndex
CREATE INDEX "zernio_social_connections_owner_user_id_idx" ON "zernio_social_connections"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_social_connections_account_id_provider_zernio_accoun_key" ON "zernio_social_connections"("account_id", "provider", "zernio_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_webhook_events_event_id_key" ON "zernio_webhook_events"("event_id");

-- CreateIndex
CREATE INDEX "zernio_webhook_events_account_id_created_at_idx" ON "zernio_webhook_events"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "zernio_webhook_events_event_type_created_at_idx" ON "zernio_webhook_events"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "linkedin_engagements_account_id_target_urn_idx" ON "linkedin_engagements"("account_id", "target_urn");

-- CreateIndex
CREATE INDEX "linkedin_engagements_account_id_target_kind_status_idx" ON "linkedin_engagements"("account_id", "target_kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_engagements_connection_id_target_urn_action_key" ON "linkedin_engagements"("connection_id", "target_urn", "action");

-- CreateIndex
CREATE INDEX "social_profile_groups_account_id_idx" ON "social_profile_groups"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_profile_groups_account_id_name_key" ON "social_profile_groups"("account_id", "name");

-- CreateIndex
CREATE INDEX "social_profile_group_members_account_id_user_id_idx" ON "social_profile_group_members"("account_id", "user_id");

-- CreateIndex
CREATE INDEX "social_profile_group_members_user_id_idx" ON "social_profile_group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_profile_group_members_group_id_user_id_key" ON "social_profile_group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "social_engagements_account_id_post_id_idx" ON "social_engagements"("account_id", "post_id");

-- CreateIndex
CREATE INDEX "social_engagements_account_id_provider_status_idx" ON "social_engagements"("account_id", "provider", "status");

-- CreateIndex
CREATE INDEX "social_engagements_source_status_next_attempt_at_idx" ON "social_engagements"("source", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_engagements_connection_id_target_post_id_action_key" ON "social_engagements"("connection_id", "target_post_id", "action");

-- CreateIndex
CREATE INDEX "sent_notifications_account_id_event_id_sent_at_idx" ON "sent_notifications"("account_id", "event_id", "sent_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_email_templates_event_id_key" ON "notification_email_templates"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "partners_referral_code_key" ON "partners"("referral_code");

-- CreateIndex
CREATE UNIQUE INDEX "account_subscriptions_stripe_subscription_id_key" ON "account_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "account_subscriptions_account_id_idx" ON "account_subscriptions"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "appsumo_plans_tier_key" ON "appsumo_plans"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "appsumo_licenses_license_key_key" ON "appsumo_licenses"("license_key");

-- CreateIndex
CREATE INDEX "appsumo_licenses_tier_idx" ON "appsumo_licenses"("tier");

-- CreateIndex
CREATE INDEX "appsumo_licenses_account_id_idx" ON "appsumo_licenses"("account_id");

-- CreateIndex
CREATE INDEX "appsumo_licenses_claimed_by_user_id_idx" ON "appsumo_licenses"("claimed_by_user_id");

-- CreateIndex
CREATE INDEX "appsumo_licenses_license_status_idx" ON "appsumo_licenses"("license_status");

-- CreateIndex
CREATE INDEX "appsumo_licenses_previous_license_key_idx" ON "appsumo_licenses"("previous_license_key");

-- CreateIndex
CREATE INDEX "appsumo_licenses_parent_license_key_idx" ON "appsumo_licenses"("parent_license_key");

-- CreateIndex
CREATE UNIQUE INDEX "appsumo_webhook_events_idempotency_key_key" ON "appsumo_webhook_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "appsumo_webhook_events_license_key_idx" ON "appsumo_webhook_events"("license_key");

-- CreateIndex
CREATE INDEX "appsumo_webhook_events_event_idx" ON "appsumo_webhook_events"("event");

-- CreateIndex
CREATE INDEX "appsumo_webhook_events_created_at_idx" ON "appsumo_webhook_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "appsumo_oauth_claims_claim_token_hash_key" ON "appsumo_oauth_claims"("claim_token_hash");

-- CreateIndex
CREATE INDEX "appsumo_oauth_claims_license_key_idx" ON "appsumo_oauth_claims"("license_key");

-- CreateIndex
CREATE INDEX "appsumo_oauth_claims_status_idx" ON "appsumo_oauth_claims"("status");

-- CreateIndex
CREATE INDEX "appsumo_oauth_claims_expires_at_idx" ON "appsumo_oauth_claims"("expires_at");

-- CreateIndex
CREATE INDEX "subscription_cancellation_feedback_account_id_idx" ON "subscription_cancellation_feedback"("account_id");

-- CreateIndex
CREATE INDEX "subscription_cancellation_feedback_account_subscription_id_idx" ON "subscription_cancellation_feedback"("account_subscription_id");

-- CreateIndex
CREATE INDEX "subscription_cancellation_feedback_stripe_subscription_id_idx" ON "subscription_cancellation_feedback"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_user_id_account_id_key" ON "user_accounts"("user_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_team_roles_account_id_name_key" ON "account_team_roles"("account_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_api_keys_key_hash_key" ON "mcp_api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "mcp_api_keys_key_hash_idx" ON "mcp_api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "mcp_api_keys_account_id_idx" ON "mcp_api_keys"("account_id");

-- CreateIndex
CREATE INDEX "mcp_api_keys_user_id_idx" ON "mcp_api_keys"("user_id");

-- CreateIndex
CREATE INDEX "admin_access_logs_user_id_created_at_idx" ON "admin_access_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "admin_access_logs_account_id_created_at_idx" ON "admin_access_logs"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "admin_access_logs_project_account_id_idx" ON "admin_access_logs"("project_account_id");

-- CreateIndex
CREATE INDEX "mcp_audit_logs_account_id_created_at_idx" ON "mcp_audit_logs"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_audit_logs_mcp_api_key_id_created_at_idx" ON "mcp_audit_logs"("mcp_api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "mcp_audit_logs_inferred_mcp_client_created_at_idx" ON "mcp_audit_logs"("inferred_mcp_client", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_hash_key" ON "oauth_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_code_hash_idx" ON "oauth_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_client_id_idx" ON "oauth_authorization_codes"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_tokens_token_hash_key" ON "oauth_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_token_hash_idx" ON "oauth_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_account_id_idx" ON "oauth_access_tokens"("account_id");

-- CreateIndex
CREATE INDEX "prompts_account_id_is_active_idx" ON "prompts"("account_id", "is_active");

-- CreateIndex
CREATE INDEX "prompts_generation_id_idx" ON "prompts"("generation_id");

-- CreateIndex
CREATE INDEX "competitors_account_id_idx" ON "competitors"("account_id");

-- CreateIndex
CREATE INDEX "competitors_domain_idx" ON "competitors"("domain");

-- CreateIndex
CREATE INDEX "topics_account_id_idx" ON "topics"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "regions_name_key" ON "regions"("name");

-- CreateIndex
CREATE INDEX "tasks_account_id_idx" ON "tasks"("account_id");

-- CreateIndex
CREATE INDEX "tasks_dup_task_id_idx" ON "tasks"("dup_task_id");

-- CreateIndex
CREATE INDEX "tasks_run_id_idx" ON "tasks"("run_id");

-- CreateIndex
CREATE INDEX "tasks_run_id_status_idx" ON "tasks"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_batches_task_id_key" ON "provider_batches"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_batches_provider_batch_id_key" ON "provider_batches"("provider_batch_id");

-- CreateIndex
CREATE INDEX "provider_batches_state_next_poll_at_idx" ON "provider_batches"("state", "next_poll_at");

-- CreateIndex
CREATE INDEX "provider_batch_items_batch_id_state_idx" ON "provider_batch_items"("batch_id", "state");

-- CreateIndex
CREATE INDEX "results_entity_idx" ON "results"("entity");

-- CreateIndex
CREATE INDEX "results_topic_id_idx" ON "results"("topic_id");

-- CreateIndex
CREATE INDEX "results_provider_idx" ON "results"("provider");

-- CreateIndex
CREATE INDEX "results_prompt_type_idx" ON "results"("prompt_type");

-- CreateIndex
CREATE INDEX "results_timestamp_idx" ON "results"("timestamp");

-- CreateIndex
CREATE INDEX "results_account_id_timestamp_idx" ON "results"("account_id", "timestamp");

-- CreateIndex
CREATE INDEX "results_account_id_run_id_idx" ON "results"("account_id", "scan_id");

-- CreateIndex
CREATE INDEX "results_account_id_entity_idx" ON "results"("account_id", "entity");

-- CreateIndex
CREATE INDEX "results_account_scan_domain_idx" ON "results"("account_id", "scan_id", "company_domain");

-- CreateIndex
CREATE INDEX "results_is_prompt_branded_idx" ON "results"("is_company_in_prompt");

-- CreateIndex
CREATE INDEX "results_region_name_idx" ON "results"("region");

-- CreateIndex
CREATE INDEX "results_company_domain_idx" ON "results"("company_domain");

-- CreateIndex
CREATE INDEX "prompt_responses_account_id_idx" ON "prompt_responses"("account_id");

-- CreateIndex
CREATE INDEX "prompt_responses_timestamp_idx" ON "prompt_responses"("timestamp");

-- CreateIndex
CREATE INDEX "prompt_responses_task_id_idx" ON "prompt_responses"("task_id");

-- CreateIndex
CREATE INDEX "prompt_responses_task_id_prompt_id_idx" ON "prompt_responses"("task_id", "prompt_id");

-- CreateIndex
CREATE INDEX "prompt_responses_account_id_prompt_id_idx" ON "prompt_responses"("account_id", "prompt_id");

-- CreateIndex
CREATE INDEX "prompt_responses_account_id_timestamp_status_purpose_idx" ON "prompt_responses"("account_id", "timestamp", "status", "purpose");

-- CreateIndex
CREATE INDEX "prompt_responses_account_id_scan_id_status_purpose_idx" ON "prompt_responses"("account_id", "scan_id", "status", "purpose");

-- CreateIndex
CREATE INDEX "prompt_responses_task_status_provider_purpose_idx" ON "prompt_responses"("task_id", "status", "provider", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "domains_domain_key" ON "domains"("domain");

-- CreateIndex
CREATE INDEX "domains_domain_type_idx" ON "domains"("domain_type");

-- CreateIndex
CREATE INDEX "domains_industry_idx" ON "domains"("industry");

-- CreateIndex
CREATE INDEX "domains_region_idx" ON "domains"("region");

-- CreateIndex
CREATE UNIQUE INDEX "article_marketplace_sites_domain_key" ON "article_marketplace_sites"("domain");

-- CreateIndex
CREATE INDEX "article_marketplace_sites_status_idx" ON "article_marketplace_sites"("status");

-- CreateIndex
CREATE INDEX "article_marketplace_sites_domain_idx" ON "article_marketplace_sites"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "article_marketplace_source_matches_cache_account_id_key" ON "article_marketplace_source_matches_cache"("account_id");

-- CreateIndex
CREATE INDEX "article_marketplace_source_matches_cache_updated_at_idx" ON "article_marketplace_source_matches_cache"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "article_token_packs_stripe_product_id_key" ON "article_token_packs"("stripe_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "article_token_packs_stripe_price_id_key" ON "article_token_packs"("stripe_price_id");

-- CreateIndex
CREATE INDEX "article_token_packs_active_idx" ON "article_token_packs"("active");

-- CreateIndex
CREATE INDEX "article_publications_account_id_state_idx" ON "article_publications"("account_id", "state");

-- CreateIndex
CREATE INDEX "article_publications_user_id_idx" ON "article_publications"("user_id");

-- CreateIndex
CREATE INDEX "article_publications_site_id_idx" ON "article_publications"("site_id");

-- CreateIndex
CREATE INDEX "article_publications_third_party_article_id_idx" ON "article_publications"("third_party_article_id");

-- CreateIndex
CREATE INDEX "article_publications_third_party_row_key_idx" ON "article_publications"("third_party_row_key");

-- CreateIndex
CREATE UNIQUE INDEX "article_token_transactions_stripe_checkout_session_id_key" ON "article_token_transactions"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX "article_token_transactions_account_id_status_idx" ON "article_token_transactions"("account_id", "status");

-- CreateIndex
CREATE INDEX "article_token_transactions_account_id_type_idx" ON "article_token_transactions"("account_id", "type");

-- CreateIndex
CREATE INDEX "article_token_transactions_article_publication_id_idx" ON "article_token_transactions"("article_publication_id");

-- CreateIndex
CREATE INDEX "article_token_transactions_stripe_payment_intent_id_idx" ON "article_token_transactions"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "recommendations_account_id_engine_version_status_priority_s_idx" ON "recommendations"("account_id", "engine_version", "status", "priority_score");

-- CreateIndex
CREATE INDEX "recommendations_account_id_idx" ON "recommendations"("account_id");

-- CreateIndex
CREATE INDEX "recommendations_prompt_id_idx" ON "recommendations"("prompt_id");

-- CreateIndex
CREATE INDEX "recommendations_batch_id_idx" ON "recommendations"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_account_id_fingerprint_key" ON "recommendations"("account_id", "fingerprint");

-- CreateIndex
CREATE INDEX "tracked_recommendations_account_id_idx" ON "tracked_recommendations"("account_id");

-- CreateIndex
CREATE INDEX "tracked_recommendations_account_id_lifecycle_status_idx" ON "tracked_recommendations"("account_id", "lifecycle_status");

-- CreateIndex
CREATE INDEX "tracked_recommendations_account_id_published_at_idx" ON "tracked_recommendations"("account_id", "published_at");

-- CreateIndex
CREATE INDEX "tracked_recommendation_links_tracked_recommendation_id_idx" ON "tracked_recommendation_links"("tracked_recommendation_id");

-- CreateIndex
CREATE INDEX "tracked_recommendation_links_post_id_idx" ON "tracked_recommendation_links"("post_id");

-- CreateIndex
CREATE INDEX "tracked_recommendation_links_recommendation_id_idx" ON "tracked_recommendation_links"("recommendation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_recommendation_links_tracked_recommendation_id_post_key" ON "tracked_recommendation_links"("tracked_recommendation_id", "post_id");

-- CreateIndex
CREATE INDEX "runs_account_id_idx" ON "scans"("account_id");

-- CreateIndex
CREATE INDEX "scans_account_id_status_grouped_competitors_scheduled_at_idx" ON "scans"("account_id", "status", "grouped_competitors", "scheduled_at" DESC);

-- CreateIndex
CREATE INDEX "idx_pages_account_id" ON "pages"("account_id");

-- CreateIndex
CREATE INDEX "page_scans_account_id_idx" ON "page_scans"("account_id");

-- CreateIndex
CREATE INDEX "page_scan_results_page_scan_id_idx" ON "page_scan_results"("page_scan_id");

-- CreateIndex
CREATE INDEX "page_scan_results_account_id_idx" ON "page_scan_results"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_settings_used_step_key" ON "ai_settings"("used_step");

-- CreateIndex
CREATE INDEX "ai_settings_used_step_idx" ON "ai_settings"("used_step");

-- CreateIndex
CREATE INDEX "posts_state_engagement_planned_at_idx" ON "posts"("state", "engagement_planned_at");

-- CreateIndex
CREATE INDEX "posts_state_distribution_planned_at_idx" ON "posts"("state", "distribution_planned_at");

-- CreateIndex
CREATE INDEX "posts_account_id_idx" ON "posts"("account_id");

-- CreateIndex
CREATE INDEX "posts_recommendation_id_idx" ON "posts"("recommendation_id");

-- CreateIndex
CREATE INDEX "posts_zernio_post_id_idx" ON "posts"("zernio_post_id");

-- CreateIndex
CREATE INDEX "posts_author_user_id_idx" ON "posts"("author_user_id");

-- CreateIndex
CREATE INDEX "content_ideas_account_id_status_created_at_idx" ON "content_ideas"("account_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_draft_sessions_account_id_created_at_idx" ON "ai_draft_sessions"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "post_approvals_approver_user_id_status_idx" ON "post_approvals"("approver_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "post_approvals_post_id_approver_user_id_key" ON "post_approvals"("post_id", "approver_user_id");

-- CreateIndex
CREATE INDEX "post_comments_post_id_created_at_idx" ON "post_comments"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "post_activities_post_id_created_at_idx" ON "post_activities"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_preferences_user_id_account_id_idx" ON "notification_preferences"("user_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_account_id_channel_key" ON "notification_preferences"("user_id", "account_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "content_notifications_source_key_key" ON "content_notifications"("source_key");

-- CreateIndex
CREATE INDEX "content_notifications_recipient_user_id_account_id_created__idx" ON "content_notifications"("recipient_user_id", "account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "content_notifications_post_id_idx" ON "content_notifications"("post_id");

-- CreateIndex
CREATE INDEX "content_notifications_delivery_planned_at_created_at_idx" ON "content_notifications"("delivery_planned_at", "created_at");

-- CreateIndex
CREATE INDEX "analytics_events_account_id_timestamp_idx" ON "analytics_events"("account_id", "timestamp");

-- CreateIndex
CREATE INDEX "cloudflare_analytics_account_id_date_idx" ON "cloudflare_analytics"("account_id", "date");

-- CreateIndex
CREATE INDEX "cloudflare_analytics_account_id_zone_id_date_idx" ON "cloudflare_analytics"("account_id", "zone_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "cloudflare_analytics_account_id_zone_id_date_hour_bot_detec_key" ON "cloudflare_analytics"("account_id", "zone_id", "date", "hour", "bot_detection_id");

-- CreateIndex
CREATE INDEX "content_sources_account_id_source_type_idx" ON "content_sources"("account_id", "source_type");

-- CreateIndex
CREATE INDEX "content_sources_account_id_ingestion_status_idx" ON "content_sources"("account_id", "ingestion_status");

-- CreateIndex
CREATE INDEX "embedding_chunks_account_id_source_type_idx" ON "embedding_chunks"("account_id", "source_type");

-- CreateIndex
CREATE INDEX "embedding_chunks_content_source_id_idx" ON "embedding_chunks"("content_source_id");

-- CreateIndex
CREATE INDEX "embedding_chunks_account_id_is_active_idx" ON "embedding_chunks"("account_id", "is_active");

-- CreateIndex
CREATE INDEX "post_chunk_usage_post_id_idx" ON "post_chunk_usage"("post_id");

-- CreateIndex
CREATE INDEX "post_chunk_usage_chunk_id_idx" ON "post_chunk_usage"("chunk_id");

-- CreateIndex
CREATE INDEX "tags_account_id_idx" ON "tags"("account_id");

-- CreateIndex
CREATE INDEX "tags_account_id_deleted_at_idx" ON "tags"("account_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "tags_account_id_name_key" ON "tags"("account_id", "name");

-- CreateIndex
CREATE INDEX "audiences_account_id_idx" ON "audiences"("account_id");

-- CreateIndex
CREATE INDEX "audiences_account_id_deleted_at_idx" ON "audiences"("account_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "zernio_connect_sessions_state_hash_key" ON "zernio_connect_sessions"("state_hash");

-- CreateIndex
CREATE INDEX "zernio_connect_sessions_expires_at_idx" ON "zernio_connect_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "zernio_connect_sessions_account_id_initiating_user_id_idx" ON "zernio_connect_sessions"("account_id", "initiating_user_id");

-- CreateIndex
CREATE INDEX "ui_page_cache_account_id_ui_page_path_idx" ON "ui_page_cache"("account_id", "ui_page", "path");

-- CreateIndex
CREATE INDEX "ui_page_cache_account_id_ui_page_expires_at_idx" ON "ui_page_cache"("account_id", "ui_page", "expires_at");

-- CreateIndex
CREATE INDEX "ui_page_cache_status_idx" ON "ui_page_cache"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ui_page_cache_account_id_ui_page_path_key" ON "ui_page_cache"("account_id", "ui_page", "path");

-- CreateIndex
CREATE UNIQUE INDEX "slack_connections_account_id_key" ON "slack_connections"("account_id");

-- CreateIndex
CREATE INDEX "slack_audit_logs_account_id_created_at_idx" ON "slack_audit_logs"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_assistant_sessions_account_id_user_id_updated_at_idx" ON "ai_assistant_sessions"("account_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_assistant_messages_session_id_created_at_idx" ON "ai_assistant_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "release_announcements_state_published_at_idx" ON "release_announcements"("state", "published_at");

-- CreateIndex
CREATE INDEX "release_announcement_slides_announcement_id_idx" ON "release_announcement_slides"("announcement_id");

-- CreateIndex
CREATE UNIQUE INDEX "release_announcement_slides_announcement_id_sort_order_key" ON "release_announcement_slides"("announcement_id", "sort_order");

-- CreateIndex
CREATE INDEX "user_announcement_views_user_id_idx" ON "user_announcement_views"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_announcement_views_user_id_announcement_id_key" ON "user_announcement_views"("user_id", "announcement_id");

-- CreateIndex
CREATE INDEX "recommendation_runs_status_lease_until_idx" ON "recommendation_runs"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_runs_account_id_window_start_engine_version_key" ON "recommendation_runs"("account_id", "window_start", "engine_version");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_project_budgets_project_account_id_window_st_key" ON "recommendation_project_budgets"("project_account_id", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_evidence_sources_account_id_source_key_key" ON "recommendation_evidence_sources"("account_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_evidence_snapshots_source_id_content_hash_key" ON "recommendation_evidence_snapshots"("source_id", "content_hash");

-- CreateIndex
CREATE INDEX "recommendation_versions_account_id_created_at_idx" ON "recommendation_versions"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_versions_recommendation_id_input_hash_key" ON "recommendation_versions"("recommendation_id", "input_hash");

-- CreateIndex
CREATE UNIQUE INDEX "content_delivery_jobs_dedupe_key_key" ON "content_delivery_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "content_delivery_jobs_status_next_attempt_at_idx" ON "content_delivery_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "content_delivery_jobs_account_id_post_id_idx" ON "content_delivery_jobs"("account_id", "post_id");

-- CreateIndex
CREATE INDEX "ops_runs_startedAt_environment_process_idx" ON "ops_runs"("startedAt", "environment", "process");

-- CreateIndex
CREATE INDEX "ops_runs_projectId_startedAt_idx" ON "ops_runs"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "ops_runs_status_deadlineAt_idx" ON "ops_runs"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "ops_usage_runId_occurredAt_idx" ON "ops_usage"("runId", "occurredAt");

-- CreateIndex
CREATE INDEX "ops_usage_occurredAt_provider_model_idx" ON "ops_usage"("occurredAt", "provider", "model");

-- CreateIndex
CREATE INDEX "ops_usage_pricedAt_completedAt_idx" ON "ops_usage"("pricedAt", "completedAt");

-- CreateIndex
CREATE INDEX "ops_prices_provider_model_validFrom_idx" ON "ops_prices"("provider", "model", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ops_sources_provider_billingAccount_name_key" ON "ops_sources"("provider", "billingAccount", "name");

-- CreateIndex
CREATE INDEX "ops_bills_occurredAt_currency_provider_idx" ON "ops_bills"("occurredAt", "currency", "provider");

-- CreateIndex
CREATE INDEX "ops_bills_projectId_occurredAt_idx" ON "ops_bills"("projectId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ops_bills_sourceId_revision_sourceKey_key" ON "ops_bills"("sourceId", "revision", "sourceKey");

-- CreateIndex
CREATE INDEX "ops_allocations_projectId_idx" ON "ops_allocations"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_allocations_billId_projectId_key" ON "ops_allocations"("billId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ops_incidents_fingerprint_key" ON "ops_incidents"("fingerprint");

-- CreateIndex
CREATE INDEX "ops_incidents_state_lastSeenAt_idx" ON "ops_incidents"("state", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ops_snapshots_filterHash_createdAt_idx" ON "ops_snapshots"("filterHash", "createdAt");

-- CreateIndex
CREATE INDEX "account_feature_flags_account_id_idx" ON "account_feature_flags"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_feature_flags_account_id_feature_key_key" ON "account_feature_flags"("account_id", "feature_key");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_account_id_fkey" FOREIGN KEY ("parent_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_project_account_id_fkey" FOREIGN KEY ("project_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_keyword_syncs" ADD CONSTRAINT "gsc_keyword_syncs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_keyword_days" ADD CONSTRAINT "gsc_keyword_days_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gsc_keyword_daily" ADD CONSTRAINT "gsc_keyword_daily_day_id_fkey" FOREIGN KEY ("day_id") REFERENCES "gsc_keyword_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_websites" ADD CONSTRAINT "generated_websites_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_orders" ADD CONSTRAINT "domain_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_edit_sessions" ADD CONSTRAINT "website_edit_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_edit_sessions" ADD CONSTRAINT "website_edit_sessions_generated_website_id_fkey" FOREIGN KEY ("generated_website_id") REFERENCES "generated_websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_edit_messages" ADD CONSTRAINT "website_edit_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "website_edit_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_workflows" ADD CONSTRAINT "content_workflows_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_workflows" ADD CONSTRAINT "content_workflows_recommendation_version_id_fkey" FOREIGN KEY ("recommendation_version_id") REFERENCES "recommendation_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_generation_runs" ADD CONSTRAINT "content_generation_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "content_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_briefs" ADD CONSTRAINT "content_briefs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "content_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "content_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_appsumo_plan_tier_fkey" FOREIGN KEY ("appsumo_plan_tier") REFERENCES "appsumo_plans"("tier") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_profiles" ADD CONSTRAINT "zernio_profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_profiles" ADD CONSTRAINT "zernio_profiles_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_social_connections" ADD CONSTRAINT "zernio_social_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_social_connections" ADD CONSTRAINT "zernio_social_connections_zernio_profile_record_id_fkey" FOREIGN KEY ("zernio_profile_record_id") REFERENCES "zernio_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_social_connections" ADD CONSTRAINT "zernio_social_connections_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_social_connections" ADD CONSTRAINT "zernio_social_connections_publisher_connection_id_fkey" FOREIGN KEY ("publisher_connection_id") REFERENCES "zernio_social_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zernio_webhook_events" ADD CONSTRAINT "zernio_webhook_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_engagements" ADD CONSTRAINT "linkedin_engagements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_engagements" ADD CONSTRAINT "linkedin_engagements_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "zernio_social_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_profile_groups" ADD CONSTRAINT "social_profile_groups_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_profile_group_members" ADD CONSTRAINT "social_profile_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "social_profile_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_profile_group_members" ADD CONSTRAINT "social_profile_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_profile_group_members" ADD CONSTRAINT "social_profile_group_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_engagements" ADD CONSTRAINT "social_engagements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_engagements" ADD CONSTRAINT "social_engagements_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "zernio_social_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_notifications" ADD CONSTRAINT "sent_notifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appsumo_licenses" ADD CONSTRAINT "appsumo_licenses_tier_fkey" FOREIGN KEY ("tier") REFERENCES "appsumo_plans"("tier") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appsumo_licenses" ADD CONSTRAINT "appsumo_licenses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appsumo_licenses" ADD CONSTRAINT "appsumo_licenses_claimed_by_user_id_fkey" FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_cancellation_feedback" ADD CONSTRAINT "subscription_cancellation_feedback_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_cancellation_feedback" ADD CONSTRAINT "subscription_cancellation_feedback_account_subscription_id_fkey" FOREIGN KEY ("account_subscription_id") REFERENCES "account_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_team_roles" ADD CONSTRAINT "account_team_roles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_audit_logs" ADD CONSTRAINT "mcp_audit_logs_mcp_api_key_id_fkey" FOREIGN KEY ("mcp_api_key_id") REFERENCES "mcp_api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_audit_logs" ADD CONSTRAINT "mcp_audit_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_mcp_api_key_id_fkey" FOREIGN KEY ("mcp_api_key_id") REFERENCES "mcp_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_region_name_fkey" FOREIGN KEY ("region_name") REFERENCES "regions"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dup_task_id_fkey" FOREIGN KEY ("dup_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_batches" ADD CONSTRAINT "provider_batches_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_batch_items" ADD CONSTRAINT "provider_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "provider_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_responses" ADD CONSTRAINT "prompt_responses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_responses" ADD CONSTRAINT "prompt_responses_dup_response_id_fkey" FOREIGN KEY ("dup_response_id") REFERENCES "prompt_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_responses" ADD CONSTRAINT "prompt_responses_related_response_id_fkey" FOREIGN KEY ("related_response_id") REFERENCES "prompt_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_marketplace_source_matches_cache" ADD CONSTRAINT "article_marketplace_source_matches_cache_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_publications" ADD CONSTRAINT "article_publications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_publications" ADD CONSTRAINT "article_publications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_publications" ADD CONSTRAINT "article_publications_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "article_marketplace_sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_token_transactions" ADD CONSTRAINT "article_token_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_token_transactions" ADD CONSTRAINT "article_token_transactions_token_pack_id_fkey" FOREIGN KEY ("token_pack_id") REFERENCES "article_token_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_token_transactions" ADD CONSTRAINT "article_token_transactions_article_publication_id_fkey" FOREIGN KEY ("article_publication_id") REFERENCES "article_publications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendations" ADD CONSTRAINT "tracked_recommendations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendations" ADD CONSTRAINT "tracked_recommendations_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendations" ADD CONSTRAINT "tracked_recommendations_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendations" ADD CONSTRAINT "tracked_recommendations_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendation_links" ADD CONSTRAINT "tracked_recommendation_links_tracked_recommendation_id_fkey" FOREIGN KEY ("tracked_recommendation_id") REFERENCES "tracked_recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendation_links" ADD CONSTRAINT "tracked_recommendation_links_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_recommendation_links" ADD CONSTRAINT "tracked_recommendation_links_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "fk_pages_account" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "page_scans" ADD CONSTRAINT "page_scans_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_scan_results" ADD CONSTRAINT "page_scan_results_page_scan_id_fkey" FOREIGN KEY ("page_scan_id") REFERENCES "page_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_scan_results" ADD CONSTRAINT "page_scan_results_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_converted_post_id_fkey" FOREIGN KEY ("converted_post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft_sessions" ADD CONSTRAINT "ai_draft_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft_sessions" ADD CONSTRAINT "ai_draft_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_approvals" ADD CONSTRAINT "post_approvals_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_approvals" ADD CONSTRAINT "post_approvals_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_activities" ADD CONSTRAINT "post_activities_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_activities" ADD CONSTRAINT "post_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_notifications" ADD CONSTRAINT "content_notifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_notifications" ADD CONSTRAINT "content_notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_notifications" ADD CONSTRAINT "content_notifications_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_requests" ADD CONSTRAINT "feature_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "async_jobs" ADD CONSTRAINT "async_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding_chunks" ADD CONSTRAINT "embedding_chunks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding_chunks" ADD CONSTRAINT "embedding_chunks_content_source_id_fkey" FOREIGN KEY ("content_source_id") REFERENCES "content_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_chunk_usage" ADD CONSTRAINT "post_chunk_usage_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_chunk_usage" ADD CONSTRAINT "post_chunk_usage_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "embedding_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ui_page_cache" ADD CONSTRAINT "ui_page_cache_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_audit_logs" ADD CONSTRAINT "slack_audit_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assistant_sessions" ADD CONSTRAINT "ai_assistant_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assistant_sessions" ADD CONSTRAINT "ai_assistant_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assistant_messages" ADD CONSTRAINT "ai_assistant_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_assistant_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_announcement_slides" ADD CONSTRAINT "release_announcement_slides_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "release_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_announcement_views" ADD CONSTRAINT "user_announcement_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_announcement_views" ADD CONSTRAINT "user_announcement_views_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "release_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_runs" ADD CONSTRAINT "recommendation_runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_evidence_sources" ADD CONSTRAINT "recommendation_evidence_sources_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_evidence_snapshots" ADD CONSTRAINT "recommendation_evidence_snapshots_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "recommendation_evidence_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_versions" ADD CONSTRAINT "recommendation_versions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_versions" ADD CONSTRAINT "recommendation_versions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "recommendation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_delivery_jobs" ADD CONSTRAINT "content_delivery_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_delivery_jobs" ADD CONSTRAINT "content_delivery_jobs_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_delivery_jobs" ADD CONSTRAINT "content_delivery_jobs_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_delivery_jobs" ADD CONSTRAINT "content_delivery_jobs_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "content_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_mention_reads" ADD CONSTRAINT "content_mention_reads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_mention_reads" ADD CONSTRAINT "content_mention_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_mention_reads" ADD CONSTRAINT "content_mention_reads_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "zernio_social_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_feature_flags" ADD CONSTRAINT "account_feature_flags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
