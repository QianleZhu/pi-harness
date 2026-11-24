import type {
  CreateMemoryInput,
  CreateUserProfileInput,
  MemoryRecord,
  MemorySettings,
  MemoryState,
  UpdateMemoryInput,
  UpdateMemorySettingsInput,
  UpdateUserProfileInput,
  UserProfileItem,
} from "@pi-harness/memory/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createMemory,
  createUserProfile,
  deleteMemory,
  deleteUserProfile,
  updateMemory,
  updateMemorySettings,
  updateUserProfile,
} from "../api/memory-api";
import { memoryQueryKeys, memoryQueryOptions } from "../api/memory-queries";

export function useMemories() {
  const queryClient = useQueryClient();
  const query = useQuery(memoryQueryOptions());
  const createMutation = useMutation({
    mutationFn: createMemory,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all }),
  });
  const updateMutation = useMutation<
    MemoryRecord,
    Error,
    { input: UpdateMemoryInput; memoryId: string }
  >({
    mutationFn: ({ input, memoryId }) => updateMemory(memoryId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all }),
  });
  const deleteMutation = useMutation<void, Error, { expectedRevision: number; memoryId: string }>({
    mutationFn: ({ expectedRevision, memoryId }) => deleteMemory(memoryId, expectedRevision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all }),
  });
  const createProfileMutation = useMutation({
    mutationFn: createUserProfile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all }),
  });
  const updateProfileMutation = useMutation<
    UserProfileItem,
    Error,
    { input: UpdateUserProfileInput; profileId: string }
  >({
    mutationFn: ({ input, profileId }) => updateUserProfile(profileId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all }),
  });
  const deleteProfileMutation = useMutation<void, Error, string>({
    mutationFn: deleteUserProfile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all }),
  });
  const settingsMutation = useMutation<MemorySettings, Error, UpdateMemorySettingsInput>({
    mutationFn: updateMemorySettings,
    onSuccess: (settings) => {
      queryClient.setQueryData<MemoryState>(memoryQueryKeys.all, (current) =>
        current ? { ...current, settings } : current,
      );
    },
  });

  return {
    create: (input: CreateMemoryInput) => createMutation.mutateAsync(input),
    createProfile: (input: CreateUserProfileInput) => createProfileMutation.mutateAsync(input),
    isCreating: createMutation.isPending || createProfileMutation.isPending,
    isDeleting:
      (deleteMutation.isPending ? deleteMutation.variables?.memoryId : null) ??
      (deleteProfileMutation.isPending ? deleteProfileMutation.variables : null),
    isSavingSettings: settingsMutation.isPending,
    isUpdating:
      (updateMutation.isPending ? updateMutation.variables?.memoryId : null) ??
      (updateProfileMutation.isPending ? updateProfileMutation.variables?.profileId : null),
    query,
    remove: (memoryId: string, expectedRevision: number) =>
      deleteMutation.mutateAsync({ expectedRevision, memoryId }),
    removeProfile: (profileId: string) => deleteProfileMutation.mutateAsync(profileId),
    update: (memoryId: string, input: UpdateMemoryInput) =>
      updateMutation.mutateAsync({ input, memoryId }),
    updateProfile: (profileId: string, input: UpdateUserProfileInput) =>
      updateProfileMutation.mutateAsync({ input, profileId }),
    updateSettings: settingsMutation.mutateAsync,
  };
}
