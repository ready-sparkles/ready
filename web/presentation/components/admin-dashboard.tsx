"use client";

import {
  type AdminAiUsageEvent,
  type AdminAiUsageSummary,
  type AdminOverview,
  aiCreditActionTypeValues,
  type UserPlan,
  userPlanValues,
} from "@readymeet/shared";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getAdminAiUsageEvents,
  getAdminAiUsageSummary,
  getAdminOverview,
  getApiErrorMessage,
  updateAdminUserPlan,
} from "../../composition/api";

import { useAuth } from "./auth-provider";

type AiUsageRange = "7d" | "30d" | "month" | "all";

const USER_PLAN_LABELS: Record<UserPlan, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  business: "Pro",
  business_multilingual: "Pro multilingual",
  enterprise: "Enterprise",
};
const WAITLIST_APPROVAL_PLANS: UserPlan[] = ["business", "business_multilingual", "enterprise"];

const MICRO_USD_PER_USD = 1_000_000;
const CURRENCY_SUB_UNIT_FRACTION_DIGITS = 4;
const CURRENCY_DEFAULT_FRACTION_DIGITS = 2;
const FORMAT_NUMBER_INTEGER_THRESHOLD = 100;
const FORMAT_NUMBER_SINGLE_DECIMAL_MAX = 1;
const AI_USAGE_RANGE_DAYS_7 = 7;
const AI_USAGE_RANGE_DAYS_30 = 30;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;
const TOKEN_COUNT_MILLION = 1_000_000;
const TOKEN_COUNT_THOUSAND = 1_000;
const ADMIN_AI_USAGE_EVENTS_PAGE_LIMIT = 10;
const PAYMENT_MINOR_UNITS_PER_MAJOR_USD = 100;
const PAYMENT_USD_DECIMAL_PLACES = 2;

const COPY_DATE_UNTRACKED = "Untracked";
const COPY_PERCENT_NOT_AVAILABLE = "n/a";
const COPY_MEETING_ACTION_ITEMS_LABEL = "meeting tasks";
const COPY_MEETING_TASKS_DISPLAY = "Meeting tasks";
const COPY_ALL_TIME_SUFFIX = " all time";
const COPY_THIS_MONTH_SUFFIX = " this month";
const COPY_UNPRICED_CALLS_SUFFIX = " unpriced calls";
const COPY_UNPRICED_SUFFIX = " unpriced";
const COPY_CALLS_SUFFIX = " calls";
const COPY_TOKENS_SUFFIX = " tokens";
const COPY_TOKEN_IN_OUT_SEPARATOR = " in · ";
const COPY_TOKEN_OUT_SUFFIX = " out";
const COPY_NO_RECORDED_LLM_CALLS = "No recorded LLM calls yet.";
const COPY_AI_USAGE_TITLE = "AI Usage";
const COPY_AI_USAGE_SUBTITLE = "Credit-value revenue and provider cost are admin-only economics.";
const COPY_EVENTS_SUFFIX = " events";
const COPY_LOADING_AI_USAGE = "Loading AI usage";
const COPY_BY_ACTION_TITLE = "By action";
const COPY_BY_MODEL_TITLE = "By model";
const COPY_NO_CREDIT_USAGE_RANGE = "No credit usage for this range.";
const COPY_NO_MODEL_BREAKDOWN = "No model breakdown yet.";
const COPY_NO_AI_CREDIT_EVENTS = "No AI credit events for this range.";
const COPY_CREDITS_SUFFIX = " credits";
const COPY_PROFIT_SUFFIX = " profit · ";
const COPY_COST_LABEL_SUFFIX = " cost";
const COPY_REVENUE_LABEL_SUFFIX = " revenue";
const COPY_TABLE_DATE = "Date";
const COPY_TABLE_USER = "User";
const COPY_TABLE_MEETING = "Meeting";
const COPY_TABLE_ACTION = "Action";
const COPY_TABLE_MODEL = "Model";
const COPY_TABLE_TOKENS = "Tokens";
const COPY_TABLE_COST = "Cost";
const COPY_TABLE_CREDITS = "Credits";
const COPY_TABLE_REVENUE = "Revenue";
const COPY_TABLE_PROFIT = "Profit";
const COPY_TABLE_MARGIN = "Margin";
const COPY_NO_MEETING = "No meeting";
const COPY_INCLUDED_ACTION = "included";
const COPY_UNKNOWN_MODEL = "unknown";
const COPY_LOAD_ADMIN_FALLBACK = "Unable to load admin data.";
const COPY_UPDATE_PLAN_FALLBACK = "Unable to update user plan.";
const COPY_ADMIN_TITLE = "Ready Meeting Admin";
const COPY_ADMIN_SUBTITLE = "Usage and cost";
const COPY_REFRESHING = "Refreshing";
const COPY_REFRESH = "Refresh";
const COPY_KPI_AUTHENTICATED_USERS = "Authenticated users";
const COPY_KPI_ACTIVE_THIS_MONTH = "Active this month";
const COPY_KPI_TRANSCRIBED_MEETINGS = "Transcribed meetings";
const COPY_KPI_OPEN_ROOMS = "Open rooms";
const COPY_KPI_ACTIVE_PROCESSES = "Active processes";
const COPY_KPI_TRACKED_COST_MONTH = "Tracked cost this month";
const COPY_WAITLIST_TITLE = "Waitlist";
const COPY_WAITLIST_PENDING_SUFFIX = " pending";
const COPY_TABLE_REQUESTED = "Requested";
const COPY_TABLE_AUTH = "Auth";
const COPY_TABLE_ACQUISITION = "Acquisition";
const COPY_TABLE_MEETINGS = "Meetings";
const COPY_TABLE_APPROVE = "Approve";
const COPY_UNKNOWN_PROVIDER = "Unknown provider";
const COPY_LAST_AUTH_PREFIX = "Last: ";
const COPY_AUTHS_SUFFIX = " auths";
const COPY_HOSTED_SUFFIX = " hosted";
const COPY_TRANSCRIBED_SUFFIX = " transcribed · ";
const COPY_NO_WAITLIST = "No pending waitlist requests.";
const COPY_USERS_TITLE = "Users";
const COPY_AUTHENTICATED_SUFFIX = " authenticated";
const COPY_TABLE_PLAN = "Plan";
const COPY_TABLE_AI_JOBS = "AI jobs";
const COPY_TABLE_WORKFLOWS = "Workflows";
const COPY_TABLE_OUR_COST_MONTH = "Our cost · month";
const COPY_TABLE_CREDIT_VALUE_MONTH = "Credit value · month";
const COPY_TABLE_OUR_COST_ALL_TIME = "Our cost · all time";
const COPY_TABLE_CREDIT_VALUE_ALL_TIME = "Credit value · all time";
const COPY_NOT_TRACKED = "Not tracked";
const COPY_NO_CAMPAIGN = "No campaign";
const COPY_FIRST_TOUCH_PREFIX = "First touch: ";
const COPY_FIRST_PAYMENT_PREFIX = "First payment: ";
const COPY_NO_PAYMENT_RECORDED = "No payment recorded";
const COPY_PAID_PAYMENTS_SUFFIX = " paid · ";
const COPY_PAYMENTS_SUFFIX = " payments";
const COPY_MINOR_UNITS_SUFFIX = " minor units ";
const COPY_INFRA_REALTIME_NOTE = "infra + realtime included";
const COPY_CREDIT_VALUE_SUFFIX = " credit value";
const COPY_CHARGED_ACTIONS_SUFFIX = " charged actions";
const COPY_LLM_PREFIX = "LLM ";
const COPY_TOTAL_SUFFIX = " total";
const COPY_FAILED_SUFFIX = " failed";
const COPY_STARTED_SUFFIX = " started";
const COPY_COMPLETED_SUFFIX = " completed";
const COPY_NO_USERS = "No authenticated users yet.";
const COPY_LLM_BY_USER_TITLE = "LLM usage by user";
const COPY_LLM_BY_USER_DETAIL = "tokens and model cost";
const COPY_OPEN_ROOMS_TITLE = "Open rooms";
const COPY_ACTIVE_SUFFIX = " active";
const COPY_NO_TRANSCRIPT = "no transcript";
const COPY_NO_OPEN_ROOMS = "No rooms are currently open.";
const COPY_ACTIVE_PROCESSES_TITLE = "Active processes";
const COPY_NO_ACTIVE_PROCESSES = "No queued or running AI work.";
const COPY_COST_CATEGORIES_TITLE = "Cost categories";
const COPY_COST_CATEGORIES_DETAIL = "forward-only metering";
const COPY_LOADING_ADMIN_OVERVIEW = "Loading admin overview";
const COPY_KPI_CREDITS_USED = "Credits used";
const COPY_KPI_AI_REVENUE = "AI revenue";
const COPY_KPI_AI_REVENUE_DETAIL = "credit-value revenue";
const COPY_KPI_AI_COST = "AI cost";
const COPY_KPI_AI_PROFIT = "AI profit";
const COPY_KPI_GROSS_MARGIN = "Gross margin";
const COPY_KPI_AVG_COST_CREDIT = "Average cost / credit";
const COPY_KPI_PRICE_CREDIT = "Price / credit";
const COPY_FILTER_RANGE = "Range";
const COPY_FILTER_ACTION = "Action";
const COPY_FILTER_MODEL = "Model";
const COPY_FILTER_SORT = "Sort";
const COPY_FILTER_DIRECTION = "Direction";
const COPY_ADMIN_KPIS_ARIA = "Admin KPIs";
const COPY_APPROVE_AS_PLACEHOLDER = "Approve as...";

const BILLING_SOURCE_LABELS: Record<AdminOverview["users"][number]["billing"]["source"], string> = {
  none: "No paid entitlement",
  manual: "Manual admin entitlement",
  stripe_personal: "Stripe personal subscription",
  stripe_workspace: "Stripe workspace subscription",
  manual_and_stripe: "Manual + Stripe subscription",
};

function formatCurrency(microUsd: number) {
  const isSubUnitDigits = microUsd > 0 && microUsd < MICRO_USD_PER_USD;
  const fractionDigits = isSubUnitDigits ? CURRENCY_SUB_UNIT_FRACTION_DIGITS : CURRENCY_DEFAULT_FRACTION_DIGITS;

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(microUsd / MICRO_USD_PER_USD);
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return COPY_PERCENT_NOT_AVAILABLE;
  }

  return new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= FORMAT_NUMBER_INTEGER_THRESHOLD ? 0 : FORMAT_NUMBER_SINGLE_DECIMAL_MAX,
  }).format(value);
}

function formatActionType(value: string) {
  if (value === "meeting_action_items") {
    return COPY_MEETING_ACTION_ITEMS_LABEL;
  }

  return value.replace(/_/g, " ");
}

function getAiUsageRangeParams(range: AiUsageRange) {
  const now = new Date();
  if (range === "all") {
    return {};
  }
  if (range === "month") {
    return {
      startDate: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      endDate: now.toISOString(),
    };
  }
  const days = range === "7d" ? AI_USAGE_RANGE_DAYS_7 : AI_USAGE_RANGE_DAYS_30;
  const startDate = new Date(now.getTime() - days * MS_PER_DAY);

  return {
    startDate: startDate.toISOString(),
    endDate: now.toISOString(),
  };
}

function formatTokenCount(value: number) {
  if (value >= TOKEN_COUNT_MILLION) {
    return `${formatNumber(value / TOKEN_COUNT_MILLION)}M`;
  }
  if (value >= TOKEN_COUNT_THOUSAND) {
    return `${formatNumber(value / TOKEN_COUNT_THOUSAND)}K`;
  }

  return formatNumber(value);
}

function formatDate(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return COPY_DATE_UNTRACKED;
  }

  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function billingSourceLabel(user: AdminOverview["users"][number]) {
  return BILLING_SOURCE_LABELS[user.billing.source];
}

const COPY_BILLING_CHANGED_ON_ADMIN = "Changed on this admin page";
const COPY_BILLING_FREE = "Free";
const COPY_BILLING_PERSONAL_SUFFIX = " · personal";
const COPY_BILLING_OWNER_SUFFIX = " · billing owner";
const COPY_BILLING_COVERED_MEMBER_SUFFIX = " · covered member";

function billingSourceDetail(user: AdminOverview["users"][number]) {
  const personal = user.billing.personalSubscription;
  const workspace = user.billing.workspaceSubscriptions[0];
  if (personal) {
    return `${personal.status}${COPY_BILLING_PERSONAL_SUFFIX}`;
  }
  if (workspace) {
    const roleSuffix = workspace.isBillingOwner ? COPY_BILLING_OWNER_SUFFIX : COPY_BILLING_COVERED_MEMBER_SUFFIX;

    return `${workspace.status} · ${workspace.workspaceName}${roleSuffix}`;
  }

  return user.billing.manualEntitlement ? COPY_BILLING_CHANGED_ON_ADMIN : COPY_BILLING_FREE;
}

function formatDuration(seconds: number) {
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const remainingMinutes = minutes % MINUTES_PER_HOUR;

  return remainingMinutes !== 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getMetadataNumber(params: { metadata: Record<string, unknown>; key: string }) {
  const value = params.metadata[params.key];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseAiUsageRangeFromSelect(value: string): AiUsageRange | null {
  if (value === "7d" || value === "30d" || value === "month" || value === "all") {
    return value;
  }

  return null;
}

function parseUserPlanFromSelect(value: string): UserPlan | null {
  const matchedPlan = userPlanValues.find((plan) => plan === value);

  return matchedPlan ?? null;
}

function hasNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function getCostCategoryDetail(category: AdminOverview["costCategories"][number]) {
  if (category.category === "realtime_room") {
    const billableMinutes = getMetadataNumber({
      metadata: category.metadata,
      key: "billableMonthParticipantMinutes",
    });
    const includedMinutes = getMetadataNumber({
      metadata: category.metadata,
      key: "includedParticipantMinutes",
    });
    const monthMinutes = getMetadataNumber({
      metadata: category.metadata,
      key: "monthParticipantMinutes",
    });
    const allTimeCost = `${formatCurrency(category.costMicroUsd)} all time`;
    const eventText = `${category.eventCount} events`;

    if (category.metadata.freeQuotaCovered === true) {
      const quotaText =
        includedMinutes > 0
          ? `${formatNumber(monthMinutes)} of ${formatNumber(includedMinutes)} free minutes used`
          : `${formatNumber(monthMinutes)} minutes used`;

      return `Covered by free quota · ${quotaText} · ${allTimeCost} · ${eventText}`;
    }

    return `${formatNumber(billableMinutes)} billable overage minutes · ${allTimeCost} · ${eventText}`;
  }

  return `${formatCurrency(category.costMicroUsd)} all time · ${category.eventCount} events${
    category.unconfiguredEventCount > 0 ? ` · ${category.unconfiguredEventCount} unpriced` : ""
  }`;
}

function KpiCard(props: { label: string; value: string; detail?: string }) {
  const hasDetail = props.detail !== undefined && props.detail !== "";

  return (
    <article className="admin-kpi-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {hasDetail ? <small>{props.detail}</small> : null}
    </article>
  );
}

function formatLlmMonthCostLabel(microUsd: number) {
  return formatCurrency(microUsd) + COPY_THIS_MONTH_SUFFIX;
}

function formatLlmAllTimeCostLabel(microUsd: number) {
  return formatCurrency(microUsd) + COPY_ALL_TIME_SUFFIX;
}

function formatUnpricedCallsSuffix(count: number) {
  return count > 0 ? ` · ${count}${COPY_UNPRICED_CALLS_SUFFIX}` : "";
}

function formatUnpricedSuffix(count: number) {
  return count > 0 ? ` · ${count}${COPY_UNPRICED_SUFFIX}` : "";
}

function formatCallCountLabel(count: number) {
  return `${count}${COPY_CALLS_SUFFIX}`;
}

function formatTokenInOutLabel(params: { inputTokens: number; outputTokens: number }) {
  return (
    formatTokenCount(params.inputTokens) +
    COPY_TOKEN_IN_OUT_SEPARATOR +
    formatTokenCount(params.outputTokens) +
    COPY_TOKEN_OUT_SUFFIX
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="admin-empty-state">{label}</p>;
}

function LlmUserUsage({ user }: { user: AdminOverview["users"][number] }) {
  const llmCost = user.costBreakdown.llmMicroUsd;
  const llmMonthCost = user.costBreakdown.llmMonthMicroUsd;
  const unpricedCount = user.costBreakdown.llmUnpricedCallCount;

  return (
    <div className="admin-llm-user-card">
      <div className="admin-llm-user-heading">
        <div className="admin-user-cell">
          {hasNonEmptyString(user.avatarUrl) ? <img src={user.avatarUrl} alt="" /> : <span />}
          <div>
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </div>
        </div>
        <div className="admin-stack">
          <span>{formatLlmMonthCostLabel(llmMonthCost)}</span>
          <small>
            {formatLlmAllTimeCostLabel(llmCost)}
            {formatUnpricedCallsSuffix(unpricedCount)}
          </small>
        </div>
      </div>
      {user.llmUsageByModel.length !== 0 ? (
        <div className="admin-llm-model-list">
          {user.llmUsageByModel.map((modelUsage) => (
            <div className="admin-llm-model-row" key={`${user.id}:${modelUsage.model}`}>
              <div>
                <strong>{modelUsage.model}</strong>
                <small>
                  {formatCallCountLabel(modelUsage.callCount)}
                  {formatUnpricedSuffix(modelUsage.unpricedCallCount)}
                </small>
              </div>
              <div>
                <span>{formatCurrency(modelUsage.monthCostMicroUsd)}</span>
                <small>{formatLlmAllTimeCostLabel(modelUsage.costMicroUsd)}</small>
              </div>
              <div>
                <span>{formatTokenCount(modelUsage.totalTokens) + COPY_TOKENS_SUFFIX}</span>
                <small>
                  {formatTokenInOutLabel({
                    inputTokens: modelUsage.inputTokens,
                    outputTokens: modelUsage.outputTokens,
                  })}
                </small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="admin-empty-state">{COPY_NO_RECORDED_LLM_CALLS}</p>
      )}
    </div>
  );
}

function formatTotalCountEventsLabel(totalCount: number) {
  return String(totalCount) + COPY_EVENTS_SUFFIX;
}

function formatEventCountCreditsLabel(params: { eventCount: number; creditsCharged: number }) {
  return `${params.eventCount}${COPY_EVENTS_SUFFIX} · ${formatNumber(params.creditsCharged)}${COPY_CREDITS_SUFFIX}`;
}

function formatProfitMarginLabel(params: { profitMicroUsd: number; grossMargin: number | null }) {
  return formatCurrency(params.profitMicroUsd) + COPY_PROFIT_SUFFIX + formatPercent(params.grossMargin);
}

function formatMicroUsdCostLabel(microUsd: number) {
  return formatCurrency(microUsd) + COPY_COST_LABEL_SUFFIX;
}

function formatMicroUsdRevenueLabel(microUsd: number) {
  return formatCurrency(microUsd) + COPY_REVENUE_LABEL_SUFFIX;
}

function formatActionTypeDisplay(params: { actionType: string; actionLabel: string }) {
  return params.actionType === "meeting_action_items" ? COPY_MEETING_TASKS_DISPLAY : params.actionLabel;
}

function formatIncludedActionDetail(params: { isActionIncluded: boolean; actionType: string }) {
  return params.isActionIncluded ? COPY_INCLUDED_ACTION : formatActionType(params.actionType);
}

function formatMeetingTitle(title: string | null | undefined) {
  return title ?? COPY_NO_MEETING;
}

function formatEventModel(model: string | null) {
  return model ?? COPY_UNKNOWN_MODEL;
}

type AdminUserPlanChangeHandler = (params: { userId: string; plan: UserPlan }) => void;

type AiUsageSectionProps = {
  summary: AdminAiUsageSummary | null;
  events: AdminAiUsageEvent[];
  totalCount: number;
  range: AiUsageRange;
  actionType: string;
  model: string;
  sort: string;
  direction: string;
  isLoading: boolean;
  error: string | null;
  onRangeChange: (value: AiUsageRange) => void;
  onActionTypeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onDirectionChange: (value: string) => void;
};

function AiUsageFilterRow(
  props: Pick<
    AiUsageSectionProps,
    | "range"
    | "actionType"
    | "model"
    | "sort"
    | "direction"
    | "onRangeChange"
    | "onActionTypeChange"
    | "onModelChange"
    | "onSortChange"
    | "onDirectionChange"
  >,
) {
  return (
    <div className="admin-filter-row">
      <label>
        <span>{COPY_FILTER_RANGE}</span>
        <select
          value={props.range}
          onChange={(event) => {
            const nextRange = parseAiUsageRangeFromSelect(event.target.value);
            if (nextRange !== null) {
              props.onRangeChange(nextRange);
            }
          }}
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="all">All time</option>
        </select>
      </label>
      <label>
        <span>{COPY_FILTER_ACTION}</span>
        <select value={props.actionType} onChange={(event) => props.onActionTypeChange(event.target.value)}>
          <option value="">All actions</option>
          {aiCreditActionTypeValues.map((actionType) => (
            <option key={actionType} value={actionType}>
              {formatActionType(actionType)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{COPY_FILTER_MODEL}</span>
        <input
          value={props.model}
          onChange={(event) => props.onModelChange(event.target.value)}
          placeholder="All models"
        />
      </label>
      <label>
        <span>{COPY_FILTER_SORT}</span>
        <select value={props.sort} onChange={(event) => props.onSortChange(event.target.value)}>
          <option value="date">Date</option>
          <option value="cost">Cost</option>
          <option value="credits">Credits</option>
          <option value="revenue">Revenue</option>
          <option value="profit">Profit</option>
          <option value="margin">Margin</option>
        </select>
      </label>
      <label>
        <span>{COPY_FILTER_DIRECTION}</span>
        <select value={props.direction} onChange={(event) => props.onDirectionChange(event.target.value)}>
          <option value="desc">Desc</option>
          <option value="asc">Asc</option>
        </select>
      </label>
    </div>
  );
}

function AiUsageTotalsPanel(props: { totals: AdminAiUsageSummary["totals"] | null | undefined; isLoading: boolean }) {
  if (props.totals !== null && props.totals !== undefined) {
    return (
      <div className="admin-kpi-grid admin-ai-usage-kpis">
        <KpiCard label={COPY_KPI_CREDITS_USED} value={formatNumber(props.totals.creditsCharged)} />
        <KpiCard
          label={COPY_KPI_AI_REVENUE}
          value={formatCurrency(props.totals.revenueMicroUsd)}
          detail={COPY_KPI_AI_REVENUE_DETAIL}
        />
        <KpiCard label={COPY_KPI_AI_COST} value={formatCurrency(props.totals.actualCostMicroUsd)} />
        <KpiCard label={COPY_KPI_AI_PROFIT} value={formatCurrency(props.totals.profitMicroUsd)} />
        <KpiCard label={COPY_KPI_GROSS_MARGIN} value={formatPercent(props.totals.grossMargin)} />
        <KpiCard label={COPY_KPI_AVG_COST_CREDIT} value={formatCurrency(props.totals.averageCostPerCreditMicroUsd)} />
        <KpiCard label={COPY_KPI_PRICE_CREDIT} value={formatCurrency(props.totals.pricePerCreditMicroUsd)} />
      </div>
    );
  }
  if (props.isLoading) {
    return (
      <div className="workspace-loading-status" role="status">
        {COPY_LOADING_AI_USAGE}
      </div>
    );
  }

  return null;
}

function AiUsageWarningsPanel(props: { warnings: string[] }) {
  if (props.warnings.length === 0) {
    return null;
  }

  return (
    <section className="admin-warning-card">
      {props.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </section>
  );
}

function AiUsageByActionSubpanel(props: { items: AdminAiUsageSummary["byActionType"] }) {
  const hasItems = props.items.length !== 0;

  return (
    <article className="admin-subpanel">
      <div className="admin-panel-heading">
        <h3>{COPY_BY_ACTION_TITLE}</h3>
        <span>{props.items.length}</span>
      </div>
      {hasItems ? (
        <div className="admin-list">
          {props.items.map((item) => (
            <div className="admin-list-row" key={item.key}>
              <div>
                <strong>{item.label}</strong>
                <small>
                  {formatEventCountCreditsLabel({
                    eventCount: item.eventCount,
                    creditsCharged: item.creditsCharged,
                  })}
                </small>
              </div>
              <div>
                <span>{formatCurrency(item.revenueMicroUsd)}</span>
                <small>
                  {formatProfitMarginLabel({
                    profitMicroUsd: item.profitMicroUsd,
                    grossMargin: item.grossMargin,
                  })}
                </small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState label={COPY_NO_CREDIT_USAGE_RANGE} />
      )}
    </article>
  );
}

function AiUsageByModelSubpanel(props: { items: AdminAiUsageSummary["byModel"] }) {
  const hasItems = props.items.length !== 0;

  return (
    <article className="admin-subpanel">
      <div className="admin-panel-heading">
        <h3>{COPY_BY_MODEL_TITLE}</h3>
        <span>{props.items.length}</span>
      </div>
      {hasItems ? (
        <div className="admin-list">
          {props.items.map((item) => (
            <div className="admin-list-row" key={item.key}>
              <div>
                <strong>{item.label}</strong>
                <small>
                  {formatEventCountCreditsLabel({
                    eventCount: item.eventCount,
                    creditsCharged: item.creditsCharged,
                  })}
                </small>
              </div>
              <div>
                <span>{formatMicroUsdCostLabel(item.actualCostMicroUsd)}</span>
                <small>{formatMicroUsdRevenueLabel(item.revenueMicroUsd)}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState label={COPY_NO_MODEL_BREAKDOWN} />
      )}
    </article>
  );
}

function AiUsageEventTableRow(props: { event: AdminAiUsageEvent }) {
  const event = props.event;

  return (
    <tr>
      <td>{formatDate(event.createdAt)}</td>
      <td>
        <div className="admin-stack">
          <span>{event.user.displayName}</span>
          <small>{event.user.email}</small>
        </div>
      </td>
      <td>{formatMeetingTitle(event.meeting?.title)}</td>
      <td>
        <div className="admin-stack">
          <span>{formatActionTypeDisplay({ actionType: event.actionType, actionLabel: event.actionLabel })}</span>
          <small>
            {formatIncludedActionDetail({ isActionIncluded: event.included, actionType: event.actionType })}
          </small>
        </div>
      </td>
      <td>{formatEventModel(event.model)}</td>
      <td>
        <div className="admin-stack">
          <span>{formatTokenCount(event.inputTokens + event.outputTokens)}</span>
          <small>{formatTokenInOutLabel({ inputTokens: event.inputTokens, outputTokens: event.outputTokens })}</small>
        </div>
      </td>
      <td>{formatCurrency(event.actualCostMicroUsd)}</td>
      <td>{event.creditsCharged}</td>
      <td>{formatCurrency(event.revenueMicroUsd)}</td>
      <td>{formatCurrency(event.profitMicroUsd)}</td>
      <td>{formatPercent(event.grossMargin)}</td>
    </tr>
  );
}

function AiUsageEventsTable(props: { events: AdminAiUsageEvent[] }) {
  if (props.events.length === 0) {
    return <EmptyState label={COPY_NO_AI_CREDIT_EVENTS} />;
  }

  return (
    <div className="admin-table-wrap">
      <table className="admin-table admin-ai-usage-table">
        <thead>
          <tr>
            <th>{COPY_TABLE_DATE}</th>
            <th>{COPY_TABLE_USER}</th>
            <th>{COPY_TABLE_MEETING}</th>
            <th>{COPY_TABLE_ACTION}</th>
            <th>{COPY_TABLE_MODEL}</th>
            <th>{COPY_TABLE_TOKENS}</th>
            <th>{COPY_TABLE_COST}</th>
            <th>{COPY_TABLE_CREDITS}</th>
            <th>{COPY_TABLE_REVENUE}</th>
            <th>{COPY_TABLE_PROFIT}</th>
            <th>{COPY_TABLE_MARGIN}</th>
          </tr>
        </thead>
        <tbody>
          {props.events.map((event) => (
            <AiUsageEventTableRow key={event.id} event={event} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AiUsageSection(props: AiUsageSectionProps) {
  const totals = props.summary?.totals;
  const warnings = props.summary?.warnings ?? [];
  const byActionType = props.summary?.byActionType ?? [];
  const byModel = props.summary?.byModel ?? [];
  const hasError = hasNonEmptyString(props.error);

  return (
    <section className="admin-panel admin-ai-usage-panel">
      <div className="admin-panel-heading">
        <div>
          <h2>{COPY_AI_USAGE_TITLE}</h2>
          <p>{COPY_AI_USAGE_SUBTITLE}</p>
        </div>
        <span>{formatTotalCountEventsLabel(props.totalCount)}</span>
      </div>

      <AiUsageFilterRow
        range={props.range}
        actionType={props.actionType}
        model={props.model}
        sort={props.sort}
        direction={props.direction}
        onRangeChange={props.onRangeChange}
        onActionTypeChange={props.onActionTypeChange}
        onModelChange={props.onModelChange}
        onSortChange={props.onSortChange}
        onDirectionChange={props.onDirectionChange}
      />

      {hasError ? <div className="admin-error-card">{props.error}</div> : null}

      <AiUsageTotalsPanel totals={totals} isLoading={props.isLoading} />
      <AiUsageWarningsPanel warnings={warnings} />

      <div className="admin-grid-two">
        <AiUsageByActionSubpanel items={byActionType} />
        <AiUsageByModelSubpanel items={byModel} />
      </div>

      <AiUsageEventsTable events={props.events} />
    </section>
  );
}

function formatAuthProviders(authAccounts: { provider: string }[]) {
  if (authAccounts.length === 0) {
    return COPY_UNKNOWN_PROVIDER;
  }

  return authAccounts.map((account) => account.provider).join(", ");
}

function formatLastAuthenticatedSummary(params: { lastAuthenticatedAt: string | null; authCount: number }) {
  return `${COPY_LAST_AUTH_PREFIX}${formatDate(params.lastAuthenticatedAt)} · ${String(params.authCount)}${COPY_AUTHS_SUFFIX}`;
}

function formatHostedCountLabel(count: number) {
  return String(count) + COPY_HOSTED_SUFFIX;
}

function formatTranscribedSummary(params: { transcribedMeetingsCount: number; transcribedSeconds: number }) {
  return String(params.transcribedMeetingsCount) + COPY_TRANSCRIBED_SUFFIX + formatDuration(params.transcribedSeconds);
}

function formatPendingCountLabel(count: number) {
  return String(count) + COPY_WAITLIST_PENDING_SUFFIX;
}

function formatAuthenticatedCountLabel(count: number) {
  return String(count) + COPY_AUTHENTICATED_SUFFIX;
}

function formatTrackedCostAllTimeDetail(microUsd: number) {
  return formatCurrency(microUsd) + COPY_ALL_TIME_SUFFIX;
}

function formatCreditsCountLabel(count: number) {
  return formatNumber(count) + COPY_CREDITS_SUFFIX;
}

function formatCreditValueLabel(microUsd: number) {
  return formatCurrency(microUsd) + COPY_CREDIT_VALUE_SUFFIX;
}

function formatChargedActionsLabel(count: number) {
  return String(count) + COPY_CHARGED_ACTIONS_SUFFIX;
}

function formatLlmCostInline(microUsd: number) {
  return COPY_LLM_PREFIX + formatCurrency(microUsd);
}

function formatJobTotalLabel(params: { snapshotJobCount: number; taskJobCount: number; capabilityJobCount: number }) {
  return String(params.snapshotJobCount + params.taskJobCount + params.capabilityJobCount) + COPY_TOTAL_SUFFIX;
}

function formatFailedJobsLabel(count: number) {
  return String(count) + COPY_FAILED_SUFFIX;
}

function formatWorkflowStartedLabel(count: number) {
  return String(count) + COPY_STARTED_SUFFIX;
}

function formatWorkflowCompletedLabel(count: number) {
  return String(count) + COPY_COMPLETED_SUFFIX;
}

function formatActiveParticipantsLabel(count: number) {
  return String(count) + COPY_ACTIVE_SUFFIX;
}

function formatOpenRoomSubtitle(room: AdminOverview["openRooms"][number]) {
  return `${room.roomName} · ${room.host.displayName}`;
}

function formatActiveProcessSubtitle(process: AdminOverview["activeProcesses"][number]) {
  return `${process.meetingTitle} · ${process.userEmail}`;
}

function formatUsdPaymentAmount(amountMinor: number) {
  return `$${(amountMinor / PAYMENT_MINOR_UNITS_PER_MAJOR_USD).toFixed(PAYMENT_USD_DECIMAL_PLACES)}`;
}

type AdminUserAcquisition = NonNullable<AdminOverview["users"][number]["acquisition"]>;
type AdminPayment = AdminUserAcquisition["payments"][number];

function formatPaymentSummary(payment: AdminPayment) {
  const amountText =
    payment.currency === "USD"
      ? formatUsdPaymentAmount(payment.amountMinor)
      : String(payment.amountMinor) + COPY_MINOR_UNITS_SUFFIX + payment.currency;

  return amountText + COPY_PAID_PAYMENTS_SUFFIX + String(payment.count) + COPY_PAYMENTS_SUFFIX;
}

function formatAcquisitionHeadline(user: AdminOverview["users"][number]) {
  if (user.acquisition === null || user.acquisition === undefined) {
    return COPY_NOT_TRACKED;
  }

  return `${user.acquisition.attribution.last.source} / ${user.acquisition.attribution.last.medium}`;
}

function formatFirstPaymentDetail(firstPaidAt: string | null) {
  if (firstPaidAt === null) {
    return COPY_NO_PAYMENT_RECORDED;
  }

  return COPY_FIRST_PAYMENT_PREFIX + formatDate(firstPaidAt);
}

const COPY_DEFAULT_TRANSCRIPT_MODE = "transcript";

function formatRoomTranscriptDetail(room: AdminOverview["openRooms"][number]) {
  if (!room.transcript.hasTranscript) {
    return COPY_NO_TRANSCRIPT;
  }

  const mode = room.transcript.mode;

  return mode ?? COPY_DEFAULT_TRANSCRIPT_MODE;
}

function formatApproveAriaLabel(displayName: string) {
  return `Approve ${displayName}`;
}

function formatManualPlanAriaLabel(displayName: string) {
  return `Manual plan for ${displayName}`;
}

function AdminUserAvatarCell(props: { params: { avatarUrl: string | null; displayName: string; email: string } }) {
  return (
    <div className="admin-user-cell">
      {hasNonEmptyString(props.params.avatarUrl) ? <img src={props.params.avatarUrl} alt="" /> : <span />}
      <div>
        <strong>{props.params.displayName}</strong>
        <small>{props.params.email}</small>
      </div>
    </div>
  );
}

function AdminAuthStack(props: {
  params: { lastAuthenticatedAt: string | null; authCount: number; authAccounts: { provider: string }[] };
}) {
  return (
    <div className="admin-stack">
      <span>{formatAuthProviders(props.params.authAccounts)}</span>
      <small>
        {formatLastAuthenticatedSummary({
          lastAuthenticatedAt: props.params.lastAuthenticatedAt,
          authCount: props.params.authCount,
        })}
      </small>
    </div>
  );
}

function AdminMeetingsStack(props: {
  params: { hostedMeetingsCount: number; transcribedMeetingsCount: number; transcribedSeconds: number };
}) {
  return (
    <div className="admin-stack">
      <span>{formatHostedCountLabel(props.params.hostedMeetingsCount)}</span>
      <small>
        {formatTranscribedSummary({
          transcribedMeetingsCount: props.params.transcribedMeetingsCount,
          transcribedSeconds: props.params.transcribedSeconds,
        })}
      </small>
    </div>
  );
}

function AdminUserAcquisitionCell(params: { user: AdminOverview["users"][number] }) {
  const user = params.user;
  const acquisition = user.acquisition;
  const isAcquisitionPresent = acquisition !== null && acquisition !== undefined;
  const campaign = acquisition?.attribution.last.campaign ?? COPY_NO_CAMPAIGN;
  const keyword = acquisition?.attribution.last.keyword;
  const isKeywordPresent = keyword !== undefined && keyword !== "";

  return (
    <div className="admin-stack">
      <strong>{formatAcquisitionHeadline(user)}</strong>
      {isAcquisitionPresent ? (
        <>
          <small>{campaign}</small>
          {isKeywordPresent ? <small>{keyword}</small> : null}
          <small>{COPY_FIRST_TOUCH_PREFIX + acquisition.attribution.first.source}</small>
          <small>{formatFirstPaymentDetail(acquisition.firstPaidAt)}</small>
          {acquisition.payments.map((payment) => (
            <small key={payment.currency}>{formatPaymentSummary(payment)}</small>
          ))}
        </>
      ) : null}
    </div>
  );
}

function AdminUserPlanCell(props: {
  params: {
    user: AdminOverview["users"][number];
    isSavingPlan: boolean;
    onUserPlanChange: AdminUserPlanChangeHandler;
  };
}) {
  const user = props.params.user;

  return (
    <td>
      <div className="admin-stack">
        <label className="admin-plan-select-label">
          <select
            className="admin-plan-select"
            aria-label={formatManualPlanAriaLabel(user.displayName)}
            value={user.plan}
            disabled={props.params.isSavingPlan}
            onChange={(event) => {
              const nextPlan = parseUserPlanFromSelect(event.currentTarget.value);
              if (nextPlan !== null) {
                props.params.onUserPlanChange({ userId: user.id, plan: nextPlan });
              }
            }}
          >
            {userPlanValues.map((plan) => (
              <option key={plan} value={plan}>
                {USER_PLAN_LABELS[plan]}
              </option>
            ))}
          </select>
        </label>
        <strong>{billingSourceLabel(user)}</strong>
        <small>{billingSourceDetail(user)}</small>
      </div>
    </td>
  );
}

function AdminUserUsageMetricCells(props: { user: AdminOverview["users"][number] }) {
  const user = props.user;

  return (
    <>
      <td>
        <div className="admin-stack">
          <span>
            {formatJobTotalLabel({
              snapshotJobCount: user.snapshotJobCount,
              taskJobCount: user.taskJobCount,
              capabilityJobCount: user.capabilityJobCount,
            })}
          </span>
          <small>{formatFailedJobsLabel(user.failedJobCount)}</small>
        </div>
      </td>
      <td>
        <div className="admin-stack">
          <span>{formatWorkflowStartedLabel(user.workflowRunCount)}</span>
          <small>{formatWorkflowCompletedLabel(user.workflowCompletedCount)}</small>
        </div>
      </td>
      <td>
        <div className="admin-stack">
          <span>{formatCurrency(user.trackedMonthCostMicroUsd)}</span>
          <small>{formatLlmCostInline(user.costBreakdown.llmMonthMicroUsd)}</small>
          <small>{COPY_INFRA_REALTIME_NOTE}</small>
        </div>
      </td>
      <td>
        <div className="admin-stack">
          <span>{formatCreditsCountLabel(user.creditUsage.monthCreditsCharged)}</span>
          <small>{formatCreditValueLabel(user.creditUsage.monthRevenueMicroUsd)}</small>
          <small>{formatChargedActionsLabel(user.creditUsage.monthActionCount)}</small>
        </div>
      </td>
      <td>
        <div className="admin-stack">
          <span>{formatCurrency(user.trackedCostMicroUsd)}</span>
          <small>
            {formatLlmCostInline(user.costBreakdown.llmMicroUsd)}
            {formatUnpricedSuffix(user.costBreakdown.llmUnpricedCallCount)}
          </small>
        </div>
      </td>
      <td>
        <div className="admin-stack">
          <span>{formatCreditsCountLabel(user.creditUsage.creditsCharged)}</span>
          <small>{formatCreditValueLabel(user.creditUsage.revenueMicroUsd)}</small>
          <small>{formatChargedActionsLabel(user.creditUsage.actionCount)}</small>
        </div>
      </td>
    </>
  );
}

function AdminUserTableRow(params: {
  user: AdminOverview["users"][number];
  savingPlanUserId: string | null;
  onUserPlanChange: AdminUserPlanChangeHandler;
}) {
  const user = params.user;
  const isSavingPlan = params.savingPlanUserId === user.id;
  const meetingsParams = {
    hostedMeetingsCount: user.hostedMeetingsCount,
    transcribedMeetingsCount: user.transcribedMeetingsCount,
    transcribedSeconds: user.transcribedSeconds,
  };

  return (
    <tr>
      <td>
        <AdminUserAvatarCell params={{ avatarUrl: user.avatarUrl, displayName: user.displayName, email: user.email }} />
      </td>
      <td>
        <AdminAuthStack
          params={{
            authAccounts: user.authAccounts,
            authCount: user.authCount,
            lastAuthenticatedAt: user.lastAuthenticatedAt,
          }}
        />
      </td>
      <td>
        <AdminUserAcquisitionCell user={user} />
      </td>
      <AdminUserPlanCell params={{ user, isSavingPlan, onUserPlanChange: params.onUserPlanChange }} />
      <td>
        <AdminMeetingsStack params={meetingsParams} />
      </td>
      <AdminUserUsageMetricCells user={user} />
    </tr>
  );
}

function AdminWaitlistRow(params: {
  entry: AdminOverview["waitlistEntries"][number];
  savingPlanUserId: string | null;
  onUserPlanChange: AdminUserPlanChangeHandler;
}) {
  const entry = params.entry;
  const isSavingPlan = params.savingPlanUserId === entry.user.id;
  const meetingsParams = {
    hostedMeetingsCount: entry.hostedMeetingsCount,
    transcribedMeetingsCount: entry.transcribedMeetingsCount,
    transcribedSeconds: entry.transcribedSeconds,
  };

  return (
    <tr>
      <td>
        <AdminUserAvatarCell
          params={{
            avatarUrl: entry.user.avatarUrl,
            displayName: entry.user.displayName,
            email: entry.user.email,
          }}
        />
      </td>
      <td>{formatDate(entry.requestedAt)}</td>
      <td>
        <AdminAuthStack
          params={{
            authAccounts: entry.authAccounts,
            authCount: entry.authCount,
            lastAuthenticatedAt: entry.lastAuthenticatedAt,
          }}
        />
      </td>
      <td>
        <AdminMeetingsStack params={meetingsParams} />
      </td>
      <td>
        <label className="admin-plan-select-label">
          <select
            className="admin-plan-select"
            aria-label={formatApproveAriaLabel(entry.user.displayName)}
            value=""
            disabled={isSavingPlan}
            onChange={(event) => {
              const nextPlan = parseUserPlanFromSelect(event.currentTarget.value);
              if (nextPlan !== null) {
                params.onUserPlanChange({ userId: entry.user.id, plan: nextPlan });
              }
            }}
          >
            <option value="" disabled>
              {COPY_APPROVE_AS_PLACEHOLDER}
            </option>
            {WAITLIST_APPROVAL_PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {USER_PLAN_LABELS[plan]}
              </option>
            ))}
          </select>
        </label>
      </td>
    </tr>
  );
}

type AdminOverviewPanelsProps = {
  overview: AdminOverview;
  sortedUsers: AdminOverview["users"];
  totalActiveProcesses: number;
  aiUsageSummary: AdminAiUsageSummary | null;
  aiUsageEvents: AdminAiUsageEvent[];
  aiUsageTotalCount: number;
  aiUsageRange: AiUsageRange;
  aiUsageActionType: string;
  aiUsageModel: string;
  aiUsageSort: string;
  aiUsageDirection: string;
  isLoading: boolean;
  aiUsageError: string | null;
  onAiUsageRangeChange: (value: AiUsageRange) => void;
  onAiUsageActionTypeChange: (value: string) => void;
  onAiUsageModelChange: (value: string) => void;
  onAiUsageSortChange: (value: string) => void;
  onAiUsageDirectionChange: (value: string) => void;
  savingPlanUserId: string | null;
  onUserPlanChange: AdminUserPlanChangeHandler;
};

function AdminOverviewKpiGrid(props: { params: { overview: AdminOverview; totalActiveProcesses: number } }) {
  const overview = props.params.overview;

  return (
    <section className="admin-kpi-grid" aria-label={COPY_ADMIN_KPIS_ARIA}>
      <KpiCard label={COPY_KPI_AUTHENTICATED_USERS} value={String(overview.global.authenticatedUserCount)} />
      <KpiCard label={COPY_KPI_ACTIVE_THIS_MONTH} value={String(overview.global.activeUserCount)} />
      <KpiCard label={COPY_KPI_TRANSCRIBED_MEETINGS} value={String(overview.global.transcribedMeetingCount)} />
      <KpiCard label={COPY_KPI_OPEN_ROOMS} value={String(overview.global.openRoomCount)} />
      <KpiCard label={COPY_KPI_ACTIVE_PROCESSES} value={String(props.params.totalActiveProcesses)} />
      <KpiCard
        label={COPY_KPI_TRACKED_COST_MONTH}
        value={formatCurrency(overview.global.trackedMonthCostMicroUsd)}
        detail={formatTrackedCostAllTimeDetail(overview.global.trackedCostMicroUsd)}
      />
    </section>
  );
}

function AdminOverviewWarnings(params: { warnings: string[] }) {
  if (params.warnings.length === 0) {
    return null;
  }

  return (
    <section className="admin-warning-card">
      {params.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </section>
  );
}

function AdminWaitlistPanel(params: {
  entries: AdminOverview["waitlistEntries"];
  savingPlanUserId: string | null;
  onUserPlanChange: AdminUserPlanChangeHandler;
}) {
  const hasEntries = params.entries.length !== 0;

  return (
    <section className="admin-panel">
      <div className="admin-panel-heading">
        <h2>{COPY_WAITLIST_TITLE}</h2>
        <span>{formatPendingCountLabel(params.entries.length)}</span>
      </div>
      {hasEntries ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>{COPY_TABLE_USER}</th>
                <th>{COPY_TABLE_REQUESTED}</th>
                <th>{COPY_TABLE_AUTH}</th>
                <th>{COPY_TABLE_ACQUISITION}</th>
                <th>{COPY_TABLE_MEETINGS}</th>
                <th>{COPY_TABLE_APPROVE}</th>
              </tr>
            </thead>
            <tbody>
              {params.entries.map((entry) => (
                <AdminWaitlistRow
                  key={entry.id}
                  entry={entry}
                  savingPlanUserId={params.savingPlanUserId}
                  onUserPlanChange={params.onUserPlanChange}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState label={COPY_NO_WAITLIST} />
      )}
    </section>
  );
}

function AdminUsersPanel(params: {
  sortedUsers: AdminOverview["users"];
  savingPlanUserId: string | null;
  onUserPlanChange: AdminUserPlanChangeHandler;
}) {
  const hasUsers = params.sortedUsers.length !== 0;

  return (
    <section className="admin-panel">
      <div className="admin-panel-heading">
        <h2>{COPY_USERS_TITLE}</h2>
        <span>{formatAuthenticatedCountLabel(params.sortedUsers.length)}</span>
      </div>
      {hasUsers ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>{COPY_TABLE_USER}</th>
                <th>{COPY_TABLE_AUTH}</th>
                <th>{COPY_TABLE_PLAN}</th>
                <th>{COPY_TABLE_MEETINGS}</th>
                <th>{COPY_TABLE_AI_JOBS}</th>
                <th>{COPY_TABLE_WORKFLOWS}</th>
                <th>{COPY_TABLE_OUR_COST_MONTH}</th>
                <th>{COPY_TABLE_CREDIT_VALUE_MONTH}</th>
                <th>{COPY_TABLE_OUR_COST_ALL_TIME}</th>
                <th>{COPY_TABLE_CREDIT_VALUE_ALL_TIME}</th>
              </tr>
            </thead>
            <tbody>
              {params.sortedUsers.map((user) => (
                <AdminUserTableRow
                  key={user.id}
                  user={user}
                  savingPlanUserId={params.savingPlanUserId}
                  onUserPlanChange={params.onUserPlanChange}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState label={COPY_NO_USERS} />
      )}
    </section>
  );
}

function AdminLlmUsagePanel(params: { sortedUsers: AdminOverview["users"] }) {
  const hasUsers = params.sortedUsers.length !== 0;

  return (
    <section className="admin-panel">
      <div className="admin-panel-heading">
        <h2>{COPY_LLM_BY_USER_TITLE}</h2>
        <span>{COPY_LLM_BY_USER_DETAIL}</span>
      </div>
      {hasUsers ? (
        <div className="admin-llm-user-list">
          {params.sortedUsers.map((user) => (
            <LlmUserUsage key={user.id} user={user} />
          ))}
        </div>
      ) : (
        <EmptyState label={COPY_NO_USERS} />
      )}
    </section>
  );
}

function AdminOpenRoomsPanel(params: { openRooms: AdminOverview["openRooms"] }) {
  const hasRooms = params.openRooms.length !== 0;

  return (
    <article className="admin-panel">
      <div className="admin-panel-heading">
        <h2>{COPY_OPEN_ROOMS_TITLE}</h2>
        <span>{params.openRooms.length}</span>
      </div>
      {hasRooms ? (
        <div className="admin-list">
          {params.openRooms.map((room) => (
            <div className="admin-list-row" key={room.id}>
              <div>
                <strong>{room.title}</strong>
                <small>{formatOpenRoomSubtitle(room)}</small>
              </div>
              <div>
                <span>{formatActiveParticipantsLabel(room.activeParticipantCount)}</span>
                <small>{formatRoomTranscriptDetail(room)}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState label={COPY_NO_OPEN_ROOMS} />
      )}
    </article>
  );
}

function AdminActiveProcessesPanel(params: { activeProcesses: AdminOverview["activeProcesses"] }) {
  const hasProcesses = params.activeProcesses.length !== 0;

  return (
    <article className="admin-panel">
      <div className="admin-panel-heading">
        <h2>{COPY_ACTIVE_PROCESSES_TITLE}</h2>
        <span>{params.activeProcesses.length}</span>
      </div>
      {hasProcesses ? (
        <div className="admin-list">
          {params.activeProcesses.map((process) => (
            <div className="admin-list-row" key={`${process.kind}:${process.id}`}>
              <div>
                <strong>{process.label}</strong>
                <small>{formatActiveProcessSubtitle(process)}</small>
              </div>
              <div>
                <span>{process.status}</span>
                <small>{process.phase}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState label={COPY_NO_ACTIVE_PROCESSES} />
      )}
    </article>
  );
}

function AdminCostCategoriesPanel(params: { costCategories: AdminOverview["costCategories"] }) {
  return (
    <section className="admin-panel">
      <div className="admin-panel-heading">
        <h2>{COPY_COST_CATEGORIES_TITLE}</h2>
        <span>{COPY_COST_CATEGORIES_DETAIL}</span>
      </div>
      <div className="admin-cost-grid">
        {params.costCategories.map((category) => (
          <article className="admin-cost-card" key={category.category}>
            <span>{category.category.replace(/_/g, " ")}</span>
            <strong>{formatCurrency(category.monthCostMicroUsd)}</strong>
            <small>{getCostCategoryDetail(category)}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function AdminOverviewPanels(props: AdminOverviewPanelsProps) {
  return (
    <>
      <AdminOverviewKpiGrid params={{ overview: props.overview, totalActiveProcesses: props.totalActiveProcesses }} />
      <AdminOverviewWarnings warnings={props.overview.warnings} />
      <AiUsageSection
        summary={props.aiUsageSummary}
        events={props.aiUsageEvents}
        totalCount={props.aiUsageTotalCount}
        range={props.aiUsageRange}
        actionType={props.aiUsageActionType}
        model={props.aiUsageModel}
        sort={props.aiUsageSort}
        direction={props.aiUsageDirection}
        isLoading={props.isLoading}
        error={props.aiUsageError}
        onRangeChange={props.onAiUsageRangeChange}
        onActionTypeChange={props.onAiUsageActionTypeChange}
        onModelChange={props.onAiUsageModelChange}
        onSortChange={props.onAiUsageSortChange}
        onDirectionChange={props.onAiUsageDirectionChange}
      />
      <AdminWaitlistPanel
        entries={props.overview.waitlistEntries}
        savingPlanUserId={props.savingPlanUserId}
        onUserPlanChange={props.onUserPlanChange}
      />
      <AdminUsersPanel
        sortedUsers={props.sortedUsers}
        savingPlanUserId={props.savingPlanUserId}
        onUserPlanChange={props.onUserPlanChange}
      />
      <AdminLlmUsagePanel sortedUsers={props.sortedUsers} />
      <section className="admin-grid-two admin-runtime-grid">
        <AdminOpenRoomsPanel openRooms={props.overview.openRooms} />
        <AdminActiveProcessesPanel activeProcesses={props.overview.activeProcesses} />
      </section>
      <AdminCostCategoriesPanel costCategories={props.overview.costCategories} />
    </>
  );
}

async function fetchAdminOverviewData(params: {
  sessionToken: string;
  aiUsageRange: AiUsageRange;
  aiUsageActionType: string;
  aiUsageModel: string;
  aiUsageSort: string;
  aiUsageDirection: string;
}) {
  const rangeParams = getAiUsageRangeParams(params.aiUsageRange);
  const trimmedModel = params.aiUsageModel.trim();
  const aiUsageParams = {
    ...rangeParams,
    actionType: params.aiUsageActionType !== "" ? params.aiUsageActionType : null,
    model: trimmedModel !== "" ? trimmedModel : null,
  };
  const [nextOverview, nextSummary, nextEvents] = await Promise.all([
    getAdminOverview(params.sessionToken),
    getAdminAiUsageSummary({ token: params.sessionToken, params: aiUsageParams }),
    getAdminAiUsageEvents({
      token: params.sessionToken,
      params: {
        ...aiUsageParams,
        limit: ADMIN_AI_USAGE_EVENTS_PAGE_LIMIT,
        offset: 0,
        sort: params.aiUsageSort,
        direction: params.aiUsageDirection,
      },
    }),
  ]);

  return { nextOverview, nextSummary, nextEvents };
}

function buildOverviewAfterPlanUpdate(params: {
  current: AdminOverview;
  updated: Awaited<ReturnType<typeof updateAdminUserPlan>>;
}): AdminOverview {
  const { current, updated } = params;

  return {
    ...current,
    users: current.users.map((user) =>
      user.id === updated.id
        ? {
            ...user,
            plan: updated.plan,
          }
        : user,
    ),
    waitlistEntries:
      updated.plan === "free"
        ? current.waitlistEntries.map((entry) =>
            entry.user.id === updated.id
              ? {
                  ...entry,
                  user: {
                    ...entry.user,
                    plan: updated.plan,
                  },
                }
              : entry,
          )
        : current.waitlistEntries.filter((entry) => entry.user.id !== updated.id),
  };
}

function useAdminDashboardState() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [aiUsageSummary, setAiUsageSummary] = useState<AdminAiUsageSummary | null>(null);
  const [aiUsageEvents, setAiUsageEvents] = useState<AdminAiUsageEvent[]>([]);
  const [aiUsageTotalCount, setAiUsageTotalCount] = useState(0);
  const [aiUsageRange, setAiUsageRange] = useState<AiUsageRange>("30d");
  const [aiUsageActionType, setAiUsageActionType] = useState("");
  const [aiUsageModel, setAiUsageModel] = useState("");
  const [aiUsageSort, setAiUsageSort] = useState("date");
  const [aiUsageDirection, setAiUsageDirection] = useState("desc");
  const [error, setError] = useState<string | null>(null);
  const [aiUsageError, setAiUsageError] = useState<string | null>(null);
  const [planUpdateError, setPlanUpdateError] = useState<string | null>(null);
  const [savingPlanUserId, setSavingPlanUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  return {
    overview,
    setOverview,
    aiUsageSummary,
    setAiUsageSummary,
    aiUsageEvents,
    setAiUsageEvents,
    aiUsageTotalCount,
    setAiUsageTotalCount,
    aiUsageRange,
    setAiUsageRange,
    aiUsageActionType,
    setAiUsageActionType,
    aiUsageModel,
    setAiUsageModel,
    aiUsageSort,
    setAiUsageSort,
    aiUsageDirection,
    setAiUsageDirection,
    error,
    setError,
    aiUsageError,
    setAiUsageError,
    planUpdateError,
    setPlanUpdateError,
    savingPlanUserId,
    setSavingPlanUserId,
    isLoading,
    setIsLoading,
  };
}

async function performAdminUserPlanChange(params: {
  sessionToken: string;
  userId: string;
  plan: UserPlan;
  setOverview: (value: AdminOverview | null | ((current: AdminOverview | null) => AdminOverview | null)) => void;
  setPlanUpdateError: (value: string | null) => void;
  setSavingPlanUserId: (value: string | null) => void;
  reloadOverview: () => Promise<void>;
}) {
  params.setPlanUpdateError(null);
  params.setSavingPlanUserId(params.userId);
  try {
    const updated = await updateAdminUserPlan({
      token: params.sessionToken,
      userId: params.userId,
      plan: params.plan,
    });
    params.setOverview((current) => (current === null ? current : buildOverviewAfterPlanUpdate({ current, updated })));
    await params.reloadOverview();
  } catch (updateError) {
    params.setPlanUpdateError(getApiErrorMessage({ error: updateError, fallback: COPY_UPDATE_PLAN_FALLBACK }));
  } finally {
    params.setSavingPlanUserId(null);
  }
}

function sortAdminUsersByMonthCost(users: AdminOverview["users"] | undefined) {
  return [...(users ?? [])].sort((left, right) => right.trackedMonthCostMicroUsd - left.trackedMonthCostMicroUsd);
}

function useAdminOverviewAutoLoad(params: {
  sessionToken: string | undefined;
  state: ReturnType<typeof useAdminDashboardState>;
}) {
  const { state, sessionToken } = params;

  const loadOverview = useCallback(async () => {
    if (sessionToken === undefined || sessionToken === "") {
      return;
    }

    state.setIsLoading(true);
    state.setError(null);
    state.setAiUsageError(null);
    try {
      const { nextOverview, nextSummary, nextEvents } = await fetchAdminOverviewData({
        sessionToken,
        aiUsageRange: state.aiUsageRange,
        aiUsageActionType: state.aiUsageActionType,
        aiUsageModel: state.aiUsageModel,
        aiUsageSort: state.aiUsageSort,
        aiUsageDirection: state.aiUsageDirection,
      });
      state.setOverview(nextOverview);
      state.setAiUsageSummary(nextSummary);
      state.setAiUsageEvents(nextEvents.events);
      state.setAiUsageTotalCount(nextEvents.totalCount);
    } catch (loadError) {
      const message = getApiErrorMessage({ error: loadError, fallback: COPY_LOAD_ADMIN_FALLBACK });
      state.setError(message);
      state.setAiUsageError(message);
    } finally {
      state.setIsLoading(false);
    }
  }, [
    sessionToken,
    state.aiUsageActionType,
    state.aiUsageDirection,
    state.aiUsageModel,
    state.aiUsageRange,
    state.aiUsageSort,
    state.setAiUsageError,
    state.setAiUsageEvents,
    state.setAiUsageSummary,
    state.setAiUsageTotalCount,
    state.setError,
    state.setIsLoading,
    state.setOverview,
  ]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return loadOverview;
}

function useAdminDashboardController() {
  const { session } = useAuth();
  const state = useAdminDashboardState();
  const sessionToken = session?.token;
  const loadOverview = useAdminOverviewAutoLoad({ sessionToken, state });
  const totalActiveProcesses = state.overview?.activeProcesses.length ?? 0;
  const sortedUsers = useMemo(() => sortAdminUsersByMonthCost(state.overview?.users), [state.overview?.users]);

  const handleUserPlanChange = useCallback(
    async (params: { userId: string; plan: UserPlan }) => {
      if (sessionToken === undefined || sessionToken === "") {
        return;
      }

      await performAdminUserPlanChange({
        sessionToken,
        userId: params.userId,
        plan: params.plan,
        setOverview: state.setOverview,
        setPlanUpdateError: state.setPlanUpdateError,
        setSavingPlanUserId: state.setSavingPlanUserId,
        reloadOverview: loadOverview,
      });
    },
    [loadOverview, sessionToken, state.setOverview, state.setPlanUpdateError, state.setSavingPlanUserId],
  );

  return {
    state,
    sortedUsers,
    totalActiveProcesses,
    loadOverview,
    handleUserPlanChange,
  };
}

export function AdminDashboard() {
  const model = useAdminDashboardController();
  const { state } = model;
  const hasError = hasNonEmptyString(state.error);
  const hasPlanUpdateError = hasNonEmptyString(state.planUpdateError);

  const requestUserPlanChange = (params: { userId: string; plan: UserPlan }) => {
    void model.handleUserPlanChange(params);
  };

  const handleRefreshClick = () => {
    void model.loadOverview();
  };

  return (
    <main className="admin-dashboard-shell">
      <header className="admin-dashboard-header">
        <div>
          <p>{COPY_ADMIN_TITLE}</p>
          <h1>{COPY_ADMIN_SUBTITLE}</h1>
        </div>
        <button className="admin-refresh-button" type="button" onClick={handleRefreshClick} disabled={state.isLoading}>
          {state.isLoading ? COPY_REFRESHING : COPY_REFRESH}
        </button>
      </header>

      {hasError ? <div className="admin-error-card">{state.error}</div> : null}
      {hasPlanUpdateError ? <div className="admin-error-card">{state.planUpdateError}</div> : null}

      {state.overview !== null ? (
        <AdminOverviewPanels
          overview={state.overview}
          sortedUsers={model.sortedUsers}
          totalActiveProcesses={model.totalActiveProcesses}
          aiUsageSummary={state.aiUsageSummary}
          aiUsageEvents={state.aiUsageEvents}
          aiUsageTotalCount={state.aiUsageTotalCount}
          aiUsageRange={state.aiUsageRange}
          aiUsageActionType={state.aiUsageActionType}
          aiUsageModel={state.aiUsageModel}
          aiUsageSort={state.aiUsageSort}
          aiUsageDirection={state.aiUsageDirection}
          isLoading={state.isLoading}
          aiUsageError={state.aiUsageError}
          onAiUsageRangeChange={state.setAiUsageRange}
          onAiUsageActionTypeChange={state.setAiUsageActionType}
          onAiUsageModelChange={state.setAiUsageModel}
          onAiUsageSortChange={state.setAiUsageSort}
          onAiUsageDirectionChange={state.setAiUsageDirection}
          savingPlanUserId={state.savingPlanUserId}
          onUserPlanChange={requestUserPlanChange}
        />
      ) : state.isLoading ? (
        <div className="workspace-loading-status" role="status">
          {COPY_LOADING_ADMIN_OVERVIEW}
        </div>
      ) : null}
    </main>
  );
}
