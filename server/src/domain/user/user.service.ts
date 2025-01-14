import { UserEntity } from '@app/infra/entities';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AuthUserDto } from '../auth';
import { IEntityJob, JobName } from '../job';
import {
  IAlbumRepository,
  IAssetRepository,
  ICryptoRepository,
  IJobRepository,
  ILibraryRepository,
  IStorageRepository,
  IUserRepository,
  ImmichReadStream,
  UserFindOptions,
} from '../repositories';
import { StorageCore, StorageFolder } from '../storage';
import { CreateUserDto, UpdateUserDto } from './dto';
import { CreateProfileImageResponseDto, UserResponseDto, mapCreateProfileImageResponse, mapUser } from './response-dto';
import { UserCore } from './user.core';

@Injectable()
export class UserService {
  private logger = new Logger(UserService.name);
  private userCore: UserCore;

  constructor(
    @Inject(IAlbumRepository) private albumRepository: IAlbumRepository,
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(ICryptoRepository) cryptoRepository: ICryptoRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(ILibraryRepository) libraryRepository: ILibraryRepository,
    @Inject(IStorageRepository) private storageRepository: IStorageRepository,
    @Inject(IUserRepository) private userRepository: IUserRepository,
  ) {
    this.userCore = UserCore.create(cryptoRepository, libraryRepository, userRepository);
  }

  async getAll(authUser: AuthUserDto, isAll: boolean): Promise<UserResponseDto[]> {
    const users = await this.userRepository.getList({ withDeleted: !isAll });
    return users.map(mapUser);
  }

  async get(userId: string): Promise<UserResponseDto> {
    const user = await this.userRepository.get(userId, { withDeleted: false });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return mapUser(user);
  }

  getMe(authUser: AuthUserDto): Promise<UserResponseDto> {
    return this.findOrFail(authUser.id, {}).then(mapUser);
  }

  create(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    return this.userCore.createUser(createUserDto).then(mapUser);
  }

  async update(authUser: AuthUserDto, dto: UpdateUserDto): Promise<UserResponseDto> {
    await this.findOrFail(dto.id, {});
    return this.userCore.updateUser(authUser, dto.id, dto).then(mapUser);
  }

  async delete(authUser: AuthUserDto, id: string): Promise<UserResponseDto> {
    if (!authUser.isAdmin) {
      throw new ForbiddenException('Unauthorized');
    }

    const user = await this.findOrFail(id, {});
    if (user.isAdmin) {
      throw new ForbiddenException('Cannot delete admin user');
    }

    await this.albumRepository.softDeleteAll(id);

    return this.userRepository.delete(user).then(mapUser);
  }

  async restore(authUser: AuthUserDto, id: string): Promise<UserResponseDto> {
    if (!authUser.isAdmin) {
      throw new ForbiddenException('Unauthorized');
    }

    let user = await this.findOrFail(id, { withDeleted: true });
    user = await this.userRepository.restore(user);
    await this.albumRepository.restoreAll(id);
    return mapUser(user);
  }

  async createProfileImage(
    authUser: AuthUserDto,
    fileInfo: Express.Multer.File,
  ): Promise<CreateProfileImageResponseDto> {
    const updatedUser = await this.userRepository.update(authUser.id, { profileImagePath: fileInfo.path });
    return mapCreateProfileImageResponse(updatedUser.id, updatedUser.profileImagePath);
  }

  async getProfileImage(id: string): Promise<ImmichReadStream> {
    const user = await this.findOrFail(id, {});
    if (!user.profileImagePath) {
      throw new NotFoundException('User does not have a profile image');
    }
    return this.storageRepository.createReadStream(user.profileImagePath, 'image/jpeg');
  }

  async resetAdminPassword(ask: (admin: UserResponseDto) => Promise<string | undefined>) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      throw new BadRequestException('Admin account does not exist');
    }

    const providedPassword = await ask(admin);
    const password = providedPassword || randomBytes(24).toString('base64').replace(/\W/g, '');

    await this.userCore.updateUser(admin, admin.id, { password });

    return { admin, password, provided: !!providedPassword };
  }

  async handleUserDeleteCheck() {
    const users = await this.userRepository.getDeletedUsers();
    for (const user of users) {
      if (this.isReadyForDeletion(user)) {
        await this.jobRepository.queue({ name: JobName.USER_DELETION, data: { id: user.id } });
      }
    }

    return true;
  }

  async handleUserDelete({ id }: IEntityJob) {
    const user = await this.userRepository.get(id, { withDeleted: true });
    if (!user) {
      return false;
    }

    // just for extra protection here
    if (!this.isReadyForDeletion(user)) {
      this.logger.warn(`Skipped user that was not ready for deletion: id=${id}`);
      return false;
    }

    this.logger.log(`Deleting user: ${user.id}`);

    const folders = [
      StorageCore.getLibraryFolder(user),
      StorageCore.getFolderLocation(StorageFolder.UPLOAD, user.id),
      StorageCore.getFolderLocation(StorageFolder.PROFILE, user.id),
      StorageCore.getFolderLocation(StorageFolder.THUMBNAILS, user.id),
      StorageCore.getFolderLocation(StorageFolder.ENCODED_VIDEO, user.id),
    ];

    for (const folder of folders) {
      this.logger.warn(`Removing user from filesystem: ${folder}`);
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }

    this.logger.warn(`Removing user from database: ${user.id}`);

    await this.albumRepository.deleteAll(user.id);
    await this.assetRepository.deleteAll(user.id);
    await this.userRepository.delete(user, true);

    return true;
  }

  private isReadyForDeletion(user: UserEntity): boolean {
    if (!user.deletedAt) {
      return false;
    }

    const msInDay = 86400000;
    const msDeleteWait = msInDay * 7;
    const msSinceDelete = new Date().getTime() - (Date.parse(user.deletedAt.toString()) || 0);

    return msSinceDelete >= msDeleteWait;
  }

  private async findOrFail(id: string, options: UserFindOptions) {
    const user = await this.userRepository.get(id, options);
    if (!user) {
      throw new BadRequestException('User not found');
    }
    return user;
  }
}
