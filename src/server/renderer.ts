import * as fs from 'fs'
import Bluebird from 'bluebird'
Bluebird.promisifyAll(fs)
import * as fse from 'fs-extra'
import marked from 'marked'
import ejs, { render } from 'ejs'
import simpleGit, { SimpleGit } from 'simple-git/promise'
import moment from 'moment'
import less from 'less'
import Model from './model'
import ContentHelper from '../helpers/content-helper'
const helper = new ContentHelper()
import { IPostDb, IPostRenderData, ITagRenderData } from './interfaces/post'
import { ITag } from './interfaces/tag'
import { DEFAULT_POST_PAGE_SIZE, DEFAULT_ARCHIVES_PAGE_SIZE } from '../helpers/constants'
import { IMenu } from './interfaces/menu'

export default class Renderer extends Model {
  outputDir: string = `${this.appDir}/output`
  themePath: string = ''
  postsData: IPostRenderData[] = []
  tagsData: ITagRenderData[] = []
  menuData: IMenu[] = []
  git: SimpleGit
  platformAddress = ''
  remoteUrl = ''

  constructor(appInstance: any)  {
    super(appInstance)

    this.loadConfig()

    const { setting } = this.db
    this.platformAddress = ({
      github: 'github.com',
      coding: 'git.coding.net',
    } as any)[setting.platform || 'github']

    this.remoteUrl = `https://${setting.username}:${setting.token}@${this.platformAddress}/${setting.username}/${setting.repository}.git`

    this.git = simpleGit(this.outputDir)
  }

  async preview() {
    this.db.themeConfig.domain = this.outputDir
    await this.renderAll('preview')
  }

  async publish() {
    this.db.themeConfig.domain = this.db.setting.domain
    console.log('domain', this.db.themeConfig.domain)
    await this.renderAll('publish')
    console.log('渲染完毕')
    let result = false
    const isRepo = await this.git.checkIsRepo()
    console.log(isRepo)
    if (isRepo) {
      result = await this.commonPush()
    } else {
      result = await this.firstPush()
    }
    return result
  }

  async firstPush() {
    const { setting } = this.db
    console.log('first push')

    try {
      await this.git.init()
      await this.git.addConfig('user.name', setting.username)
      await this.git.addConfig('user.email', setting.email)
      await this.git.add('./*')
      await this.git.commit('first commit')
      await this.git.addRemote('origin', this.remoteUrl)
      await this.git.push('origin', setting.branch, {'--force': true})
      return true
    } catch (e) {
      console.error(e)
      return false
    }
  }

  async commonPush() {
    console.log('common push')
    const { setting } = this.db
    const statusSummary = await this.git.status()
    console.log(statusSummary)
    await this.git.raw(['remote', 'set-url', 'origin', this.remoteUrl])

    if (statusSummary.modified.length > 0 || statusSummary.not_added.length > 0) {
      try {
        await this.git.add('./*')
        await this.git.commit(`update from hve: ${moment().format('YYYY-MM-DD HH:mm:ss')}`)
        await this.git.push('origin', this.db.setting.branch, {'--force': true})
        return true
      } catch (e) {
        console.error(e)
        return false
      }
    } else {
      await this.git.push('origin', this.db.setting.branch, {'--force': true})
      return true
    }
  }


  async renderAll(mode: string) {
    await this.clearOutputFolder()
    await this.formatDataForRender(mode)
    await this.buildCss()

    // 普通文章列表页
    await this.renderPostList('', mode)

    // 归档页
    await this.renderPostList('/archives', mode)
    // 标签列表页
    await this.renderTags()
    await this.renderPostDetail()
    await this.renderTagDetail(mode)
    await this.copyFiles()
    await this.buildCname()
  }

  /**
   * 加载配置
   */
  async loadConfig() {
    this.themePath = `${this.appDir}/themes/${this.db.themeConfig.themeName}`

    await fse.ensureDir(`${this.appDir}/output`)
    await fse.ensureDir(`${this.appDir}/output/post`)
  }

  /**
   * 格式化数据，为渲染页面准备
   */
  public formatDataForRender(mode: string): any {
    const { themeConfig } = this.db

    /** 文章数据 */
    this.postsData = this.db.posts.filter((item: IPostDb) => item.data.published)
      .map((item: IPostDb) => {
        const currentTags = item.data.tags && item.data.tags.split(' ') || []
        const result: IPostRenderData = {
          content: marked(helper.changeImageUrlLocalToDomain(item.content, this.db.themeConfig.domain), { breaks: true }),
          fileName: item.fileName,
          abstract: marked(helper.changeImageUrlLocalToDomain(item.abstract, this.db.themeConfig.domain), { breaks: true }),
          title: item.data.title,
          tags: this.db.tags
            .filter((tag: ITag) => currentTags.find((i) => i === tag.name))
            .map((tag: ITag) => ({ ...tag, link: `${this.db.themeConfig.domain}/tag/${tag.slug}${mode === 'preview' ? '/index.html' : ''}` })),
          date: item.data.date,
          dateFormat: (themeConfig.dateFormat && moment(item.data.date).format(themeConfig.dateFormat)) || item.data.date,
          feature: item.data.feature && `${helper.changeFeatureImageUrlLocalToDomain(item.data.feature, this.db.themeConfig.domain, mode)}` || '',
          link: `${this.db.themeConfig.domain}/post/${item.fileName}${mode === 'preview' ? '/index.html' : ''}`,
          hideInList: (item.data.hideInList === undefined && false) || item.data.hideInList,
        }
        return result
      })
      .sort((a: IPostRenderData, b: IPostRenderData) => moment(b.date).unix() - moment(a.date).unix())

    /** 标签数据 */
    this.tagsData = []
    this.postsData.forEach((item: IPostRenderData) => {
      item.tags.forEach((tag: ITagRenderData) => {
        if (!this.tagsData.find((t: ITagRenderData) => t.link === tag.link)) {
          this.tagsData.push(tag)
        }
      })
    })

    /** 菜单数据 */
    this.menuData = this.db.menus.map((menu: IMenu) => {
      let link = menu.link.replace(this.db.setting.domain, this.db.themeConfig.domain)

      const isSiteLink = menu.link.includes(this.db.setting.domain)
      if (isSiteLink) {
        link = `${link}${mode === 'preview' ? '/index.html' : ''}`
      }

      return {
        ...menu,
        link,
      }
    })
  }

  /**
   * 渲染文章列表，不包含隐藏的文章
   */
  public async renderPostList(extraPath?: string, mode?: string) {
    const { postPageSize, archivesPageSize } = this.db.themeConfig

    // Compatible: < v0.7.0
    const pageSize = extraPath === '/archives'
      ? archivesPageSize || DEFAULT_ARCHIVES_PAGE_SIZE
      : postPageSize ||  DEFAULT_POST_PAGE_SIZE

    const postsData = this.postsData.filter((item: IPostRenderData) => !item.hideInList)

    for (let i = 0; i * pageSize < postsData.length; i += 1) {
      const renderData = {
        menus: this.menuData,
        posts: postsData.slice(i * pageSize, (i + 1) * pageSize),
        pagination: {
          prev: '',
          next: '',
        },
        themeConfig: this.db.themeConfig,
        site: {
          posts: postsData,
          tags: this.tagsData,
        },
      }

      let renderPath = `${this.outputDir}${extraPath}/index.html`

      if (i === 0 && postsData.length > pageSize) {
        await fse.ensureDir(`${this.outputDir}${extraPath}/page`)

        renderData.pagination.next = `${this.db.themeConfig.domain}${extraPath}/page/2/${mode === 'preview' ? 'index.html' : ''}`

      } else if (i > 0 && postsData.length > pageSize) {
        await fse.ensureDir(`${this.outputDir}${extraPath}/page/${i + 1}`)

        renderPath = `${this.outputDir}${extraPath}/page/${i + 1}/index.html`

        renderData.pagination.prev = i === 1
          ? `${this.db.themeConfig.domain}${extraPath}/${mode === 'preview' ? 'index.html' : ''}`
          : `${this.db.themeConfig.domain}${extraPath}/page/${i}/${mode === 'preview' ? 'index.html' : ''}`

        renderData.pagination.next = (i + 1) * pageSize < postsData.length
          ? `${this.db.themeConfig.domain}${extraPath}/page/${i + 2}/${mode === 'preview' ? 'index.html' : ''}`
          : ''
      } else {
        await fse.ensureDir(`${this.outputDir}${extraPath}`)
      }

      let html = ''
      const renderTemplatePath  = extraPath === '/archives'
        ? `${this.themePath}/templates/archives.ejs`
        : `${this.themePath}/templates/index.ejs`

      await ejs.renderFile(renderTemplatePath, renderData, {}, async (err: any, str) => {
        if (err) {
          console.log(err)
        }
        if (str) {
          html = str
        }
      })

      console.log('👏  PostList Page:', renderPath)
      await fs.writeFileSync(renderPath, html)
    }
  }

  /**
   * 渲染文章详情页，包含隐藏的文章
   */
  async renderPostDetail() {
    for (let i = 0; i < this.postsData.length; i += 1) {
      const post: any = { ...this.postsData[i] }
      if (i < this.postsData.length - 1) {
        const nexPost = this.postsData.slice(i + 1, this.postsData.length).find((item: IPostRenderData) => !item.hideInList)
        if (nexPost) {
          post.nextPost = nexPost
        }
      }

      const renderData = {
        menus: this.menuData,
        post,
        themeConfig: this.db.themeConfig,
        commentSetting: this.db.commentSetting,
        site: {
          posts: this.postsData,
          tags: this.tagsData,
        },
      }
      let html = ''
      await ejs.renderFile(`${this.themePath}/templates/post.ejs`, renderData, {}, async (err: any, str) => {
        if (err) {
          console.error('EJS Render Error', err)
        }
        if (str) {
          html = str
        }
      })

      const renderFolerPath = `${this.outputDir}/post/${post.fileName}`
      await fse.ensureDir(renderFolerPath)
      await fs.writeFileSync(`${renderFolerPath}/index.html`, html)
    }
  }

  /**
   * 渲染标签页
   */
  async renderTags() {
    await fse.ensureDir(`${this.outputDir}/tags`)
    const renderData = {
      tags: this.tagsData,
      menus: this.menuData,
      themeConfig: this.db.themeConfig,
      site: {
        posts: this.postsData,
        tags: this.tagsData,
      },
    }

    const renderPath = `${this.outputDir}/tags/index.html`
    let html = ''
    await ejs.renderFile(`${this.themePath}/templates/tags.ejs`, renderData, {}, async (err: any, str) => {
      if (err) {
        console.log('❌', err)
      }
      if (str) {
        html = str
      }
    })
    console.log('👏  Tags Page:', renderPath)
    await fs.writeFileSync(renderPath, html)
  }

  /**
   * 渲染标签详情页
   */
  async renderTagDetail(mode?: string) {
    const usedTags = this.db.tags.filter((tag: ITag) => tag.used)
    const { postPageSize } = this.db.themeConfig

    // Compatible: < v0.7.0
    const pageSize = postPageSize || DEFAULT_POST_PAGE_SIZE

    for (const usedTag of usedTags) {
      const posts = this.postsData.filter((post: IPostRenderData) => {
        return post.tags.find((tag: ITagRenderData) => tag.slug === usedTag.slug) && !post.hideInList
      })

      const currentTag = usedTag

      const tagFolderPath = `${this.outputDir}/tag/${currentTag.slug}`
      const tagDomainPath = `${this.db.themeConfig.domain}/tag/${currentTag.slug}/`
      await fse.ensureDir(`${this.outputDir}/tag`)
      await fse.ensureDir(tagFolderPath)

      for (let i = 0; i * pageSize < posts.length; i += 1) {
        const renderData = {
          tag: currentTag,
          menus: this.menuData,
          posts: posts.slice(i * pageSize, (i + 1) * pageSize),
          pagination: {
            prev: '',
            next: '',
          },
          themeConfig: this.db.themeConfig,
          site: {
            posts: this.postsData,
            tags: this.tagsData,
          },
        }

        // 分页
        let renderPath = `${tagFolderPath}/index.html`

        if (i === 0 && posts.length > pageSize) {
          await fse.ensureDir(`${tagFolderPath}/page`)

          renderData.pagination.next = `${tagDomainPath}/page/2/${mode === 'preview' ? 'index.html' : ''}`

        } else if (i > 0 && posts.length > pageSize) {
          await fse.ensureDir(`${tagFolderPath}/page/${i + 1}`)

          renderPath = `${tagFolderPath}/page/${i + 1}/index.html`

          renderData.pagination.prev = i === 1
            ? `${tagDomainPath}${mode === 'preview' ? '/index.html' : ''}`
            : `${tagDomainPath}/page/${i}/${mode === 'preview' ? 'index.html' : ''}`

          renderData.pagination.next = (i + 1) * pageSize < posts.length
            ? `${tagDomainPath}/page/${i + 2}/${mode === 'preview' ? 'index.html' : ''}`
            : ''
        }

        let html = ''
        await ejs.renderFile(`${this.themePath}/templates/tag.ejs`, renderData, {}, async (err: any, str) => {
          if (str) {
            html = str
          }
        })
        console.log('👏  Tag Page:', renderPath)
        await fs.writeFileSync(renderPath, html)
      }
    }
  }

  /**
   * 生成 CSS
   */
  async buildCss() {
    const lessFilePath = `${this.themePath}/assets/styles/main.less`
    const cssFolderPath = `${this.outputDir}/styles`

    await fse.ensureDir(cssFolderPath)

    const lessString = await fs.readFileSync(lessFilePath, 'utf8')
    await less.render(lessString, { filename: lessFilePath }, async (err: any, cssString: Less.RenderOutput) => {
      if (err) {
        console.log(err)
      }
      await fs.writeFileSync(`${cssFolderPath}/main.css`, cssString.css)
    })
  }

  /**
   * 生成 CNAME 文件
   */
  async buildCname() {
    const cnamePath = `${this.outputDir}/CNAME`

    if (this.db.setting.cname) {
      await fs.writeFileSync(cnamePath, this.db.setting.cname)
    } else {
      await fse.removeSync(cnamePath)
    }
  }

  /**
   * 复制文件到输出文件夹
   */
  async copyFiles() {
    const postImageInputPath = `${this.appDir}/post-images`
    const postImageOutputPath = `${this.outputDir}/post-images`

    await fse.ensureDir(postImageOutputPath)
    await fse.copySync(postImageInputPath, postImageOutputPath)

    const imagesInputPath = `${this.appDir}/images`
    const imagesOutputPath = `${this.outputDir}/images`

    await fse.ensureDir(imagesOutputPath)
    await fse.copySync(imagesInputPath, imagesOutputPath)

    const mediaInputPath = `${this.themePath}/assets/media`
    const mediaOutputPath = `${this.outputDir}/media`

    await fse.ensureDir(mediaInputPath)
    await fse.copySync(mediaInputPath, mediaOutputPath)

  }

  async clearOutputFolder() {
    await fse.removeSync(`${this.outputDir}/images`)
    await fse.removeSync(`${this.outputDir}/media`)
    await fse.removeSync(`${this.outputDir}/page`)
    await fse.removeSync(`${this.outputDir}/post`)
    await fse.removeSync(`${this.outputDir}/post-images`)
    await fse.removeSync(`${this.outputDir}/styles`)
    await fse.removeSync(`${this.outputDir}/tag`)
  }

}
