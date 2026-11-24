"use client";

import { Gear, Globe, Person, Plus, TrashBin } from "@gravity-ui/icons";
import {
  Alert,
  AlertDialog,
  Button,
  Popover,
  SearchField,
  Skeleton,
  Switch,
  Tooltip,
  toast,
} from "@heroui/react";
import {
  type MemoryRecord,
  MemorySourceType,
  type UserProfileItem,
} from "@pi-harness/memory/contract";
import { useState } from "react";
import { formatChatTimestamp } from "../../../shared/utils/format-chat-timestamp";
import { getMemoryProfileFacetLabel } from "../constants/memory-profile";
import { useMemories } from "../hooks/use-memories";
import { MemoryEditorDialog, type MemoryEditorTarget } from "./memory-editor-dialog";
import type { MemoryWorkspaceOption } from "./memory-scope-select";
import { SettingsCatalogItem } from "./settings-catalog-item";
import { SettingsFilterTabs } from "./settings-filter-tabs";
import { SettingsPanelHeader } from "./settings-panel-header";

const MemoryView = {
  PROFILE: "profile",
  GLOBAL: "global",
} as const;
const MEMORY_FILTERS = [
  { id: MemoryView.PROFILE, label: "用户个性" },
  { id: MemoryView.GLOBAL, label: "全局记忆" },
];

type DeleteTarget =
  | { kind: "global"; entry: MemoryRecord }
  | { kind: "profile"; entry: UserProfileItem };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "记忆操作失败";
}

export function MemorySettingsPanel({
  workspaces: _workspaces,
}: {
  workspaces: readonly MemoryWorkspaceOption[];
}) {
  const memory = useMemories();
  const [view, setView] = useState<string>(MemoryView.PROFILE);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<MemoryEditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const memories = memory.query.data?.memories ?? [];
  const profile = memory.query.data?.profile;
  const settings = memory.query.data?.settings;
  const normalizedSearch = search.trim().toLocaleLowerCase();

  const matchesGlobalSearch = (entry: MemoryRecord) => {
    const source = entry.sourceType === MemorySourceType.MANUAL ? "手动添加" : "来自对话";
    return `${entry.content} ${source} 全局 跨项目经验`
      .toLocaleLowerCase()
      .includes(normalizedSearch);
  };
  const matchesProfileSearch = (item: UserProfileItem) => {
    const facet = getMemoryProfileFacetLabel(item.facet) ?? "";
    return `${item.content} ${facet} 用户个性`.toLocaleLowerCase().includes(normalizedSearch);
  };

  const profileSections = (profile?.sections ?? [])
    .map((section) => ({ ...section, items: section.items.filter(matchesProfileSearch) }))
    .filter(({ items }) => items.length > 0);
  const visibleGlobal = memories.filter(matchesGlobalSearch);
  const visibleCount =
    view === MemoryView.PROFILE
      ? profileSections.reduce((sum, section) => sum + section.items.length, 0)
      : visibleGlobal.length;

  const refreshAfterError = (error: unknown) => {
    toast.danger(errorMessage(error));
    void memory.query.refetch();
  };

  const renderProfileItem = (item: UserProfileItem) => {
    const facetLabel = getMemoryProfileFacetLabel(item.facet);
    return (
      <SettingsCatalogItem
        key={item.id}
        ariaLabel={`编辑用户个性：${item.content}`}
        name={item.content}
        icon={<Person aria-hidden className="size-5 text-muted" />}
        onPress={() => setEditor({ kind: "profile", entry: item })}
        secondary={
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {facetLabel ? <span>{facetLabel}</span> : null}
            <span>手动维护</span>
            <span>{formatChatTimestamp(item.updatedAt)}</span>
          </span>
        }
        action={
          <Tooltip>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="text-muted data-[hovered]:text-danger"
              aria-label={`删除用户个性：${item.content}`}
              onPress={() => setDeleteTarget({ kind: "profile", entry: item })}
            >
              <TrashBin aria-hidden className="size-4" />
            </Button>
            <Tooltip.Content>删除用户个性</Tooltip.Content>
          </Tooltip>
        }
      />
    );
  };

  const renderGlobalMemory = (entry: MemoryRecord) => {
    return (
      <SettingsCatalogItem
        key={entry.id}
        ariaLabel={`编辑全局记忆：${entry.content}`}
        name={entry.content}
        icon={<Globe aria-hidden className="size-5 text-muted" />}
        onPress={() => setEditor({ kind: "global", entry })}
        secondary={
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>全局 · 跨项目经验</span>
            <span>{entry.sourceType === MemorySourceType.MANUAL ? "手动添加" : "来自对话"}</span>
            <span>{formatChatTimestamp(entry.updatedAt)}</span>
          </span>
        }
        action={
          <Tooltip>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="text-muted data-[hovered]:text-danger"
              aria-label={`删除全局记忆：${entry.content}`}
              onPress={() => setDeleteTarget({ kind: "global", entry })}
            >
              <TrashBin aria-hidden className="size-4" />
            </Button>
            <Tooltip.Content>删除全局记忆</Tooltip.Content>
          </Tooltip>
        }
      />
    );
  };

  return (
    <section aria-label="记忆设置" className="w-full max-w-[720px]">
      <SettingsPanelHeader
        title="记忆"
        description="管理用户画像、个人偏好和项目背景。"
        action={
          <div className="flex items-center gap-2">
            <Popover>
              <Button size="sm" variant="ghost">
                <Gear aria-hidden className="size-4" />
                记忆设置
              </Button>
              <Popover.Content
                className="w-96 max-w-[calc(100vw-2rem)]"
                offset={8}
                placement="bottom end"
              >
                <Popover.Dialog className="p-3">
                  <Popover.Heading className="text-sm font-medium">记忆设置</Popover.Heading>
                  <div className="mt-3 flex flex-col gap-4">
                    <div className="flex items-start gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">使用记忆</p>
                        <p className="mt-1 text-xs text-muted">
                          {settings?.useMemories
                            ? "在对话中参考已保存的记忆。"
                            : "已暂停使用，仍可查看和管理记忆。"}
                        </p>
                      </div>
                      <Switch
                        aria-label="使用记忆"
                        className="mt-0.5 shrink-0"
                        isDisabled={!settings || memory.isSavingSettings}
                        isSelected={settings?.useMemories ?? false}
                        onChange={(useMemories) => {
                          void memory.updateSettings({ useMemories }).catch(refreshAfterError);
                        }}
                      >
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                        </Switch.Content>
                      </Switch>
                    </div>
                    <div className="flex items-start gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">生成记忆</p>
                        <p className="mt-1 text-xs text-muted">
                          {settings?.generateMemories
                            ? "允许在对话中记录暂存记忆并由 Dreaming 后台整理。"
                            : "已暂停生成记忆，正在进行的整理不受影响。"}
                        </p>
                      </div>
                      <Switch
                        aria-label="生成记忆"
                        className="mt-0.5 shrink-0"
                        isDisabled={!settings || memory.isSavingSettings}
                        isSelected={settings?.generateMemories ?? false}
                        onChange={(generateMemories) => {
                          void memory.updateSettings({ generateMemories }).catch(refreshAfterError);
                        }}
                      >
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                        </Switch.Content>
                      </Switch>
                    </div>
                    <p className="text-xs text-muted">
                      混合检索由本机 multilingual-e5-small
                      与关键词索引共同完成，首次使用会自动下载模型。
                    </p>
                  </div>
                </Popover.Dialog>
              </Popover.Content>
            </Popover>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={memory.query.isPending}
              onPress={() =>
                setEditor({
                  kind: view === MemoryView.PROFILE ? "profile" : "global",
                  entry: null,
                })
              }
            >
              <Plus aria-hidden className="size-4" />
              {view === MemoryView.PROFILE ? "添加个性" : "添加全局记忆"}
            </Button>
          </div>
        }
      />
      {memory.query.isError ? (
        <Alert className="mt-4" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>记忆加载失败</Alert.Title>
            <Alert.Description>{memory.query.error.message}</Alert.Description>
            <Button size="sm" variant="tertiary" onPress={() => void memory.query.refetch()}>
              重试
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}
      <div className="mt-5 flex flex-col gap-3">
        <div className="flex flex-col gap-3 @xl/settings:flex-row @xl/settings:items-center @xl/settings:justify-between">
          <SettingsFilterTabs
            label="筛选记忆"
            items={MEMORY_FILTERS}
            selectedKey={view}
            onSelectionChange={setView}
          />
          <SearchField
            aria-label="搜索记忆"
            className="w-full min-w-0 @xl/settings:w-64"
            value={search}
            onChange={setSearch}
            variant="secondary"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="搜索记忆" />
              <SearchField.ClearButton aria-label="清除搜索" />
            </SearchField.Group>
          </SearchField>
        </div>
        {view === MemoryView.PROFILE ? (
          <p className="px-3 text-xs text-muted">用户个性仅通过手动输入更新和删除。</p>
        ) : (
          <p className="px-3 text-xs text-muted">
            跨项目通用经验，工作区项目记忆由 Dreaming 自动维护。
          </p>
        )}
        {memory.query.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-1" role="status">
            <span className="sr-only">正在加载记忆</span>
            {["first", "second", "third"].map((item) => (
              <div className="flex min-h-16 items-center gap-3 px-3 py-2" key={item}>
                <Skeleton aria-hidden className="size-10 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton aria-hidden className="h-5 w-full rounded-lg" />
                  <Skeleton aria-hidden className="h-4 w-64 max-w-full rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        ) : view === MemoryView.PROFILE ? (
          <div className="flex flex-col gap-5">
            {profileSections.map((section) => (
              <section aria-labelledby={`profile-${section.facet}`} key={section.facet}>
                <h3
                  className="mb-1 px-3 text-xs font-medium text-muted"
                  id={`profile-${section.facet}`}
                >
                  {getMemoryProfileFacetLabel(section.facet)}
                </h3>
                <ul className="flex flex-col gap-1">{section.items.map(renderProfileItem)}</ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">{visibleGlobal.map(renderGlobalMemory)}</ul>
        )}
        {!memory.query.isPending && visibleCount === 0 ? (
          <div className="py-8 text-center" role="status">
            <p className="text-sm text-muted">
              {search
                ? "没有找到匹配的记录"
                : view === MemoryView.PROFILE
                  ? "暂无用户个性"
                  : "暂无全局记忆"}
            </p>
            {search ? (
              <Button className="mt-3" size="sm" variant="tertiary" onPress={() => setSearch("")}>
                清除搜索
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {editor ? (
        <MemoryEditorDialog
          target={editor}
          isSaving={
            memory.isCreating || (editor.entry !== null && memory.isUpdating === editor.entry.id)
          }
          onClose={() => setEditor(null)}
          onSave={async (payload) => {
            try {
              if (payload.kind === "profile") {
                if (editor.kind === "profile" && editor.entry) {
                  await memory.updateProfile(editor.entry.id, {
                    content: payload.content,
                    facet: payload.facet,
                  });
                } else {
                  await memory.createProfile({
                    content: payload.content,
                    facet: payload.facet,
                  });
                }
              } else if (editor.kind === "global" && editor.entry) {
                await memory.update(editor.entry.id, {
                  content: payload.content,
                  expectedRevision: editor.entry.revision,
                });
              } else {
                await memory.create({ content: payload.content });
              }
              setEditor(null);
              toast.success("已保存");
            } catch (error: unknown) {
              refreshAfterError(error);
            }
          }}
        />
      ) : null}
      <AlertDialog.Backdrop
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !memory.isDeleting) setDeleteTarget(null);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>
                {deleteTarget?.kind === "profile" ? "删除这条用户个性？" : "删除这条全局记忆？"}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="break-words">{deleteTarget?.entry.content}</p>
              <p className="mt-3 text-sm text-muted">删除后，此内容将从记忆库中移除。</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                variant="tertiary"
                isDisabled={memory.isDeleting !== null}
                onPress={() => setDeleteTarget(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                isPending={deleteTarget !== null && memory.isDeleting === deleteTarget.entry.id}
                onPress={() => {
                  if (!deleteTarget) return;
                  const task =
                    deleteTarget.kind === "profile"
                      ? memory.removeProfile(deleteTarget.entry.id)
                      : memory.remove(deleteTarget.entry.id, deleteTarget.entry.revision);
                  void task
                    .then(() => {
                      setDeleteTarget(null);
                      toast.success("已移除");
                    })
                    .catch(refreshAfterError);
                }}
              >
                确认移除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  );
}
